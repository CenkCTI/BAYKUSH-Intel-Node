import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parse } from "csv-parse";
import { z } from "zod";
import { config } from "../config.js";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedArtifact } from "../http/source-artifact.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { BoundedTopK } from "../utils/bounded-top-k.js";

export const FIRST_EPSS_CURRENT_URL = new URL("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz");
export const FIRST_EPSS_CAPTURE_PROFILE = Object.freeze({
  key: "EPSS_HIGH_SIGNAL_V1",
  minimumEpss: 0.1,
  maximumRecords: 2_500,
  ordering: ["epss_desc", "percentile_desc", "cve_asc"] as const,
});

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_DATASET_ROWS = 1_000_000;
const MAX_COLUMNS = 32;
const MAX_CSV_RECORD_BYTES = 4_096;
const MAX_METADATA_LINE_BYTES = 4_096;
const MAX_RAW_RECORD_BYTES = 256 * 1024;
const SAME_MODEL_ROW_DROP_RATIO = 0.75;
const SOURCE_SCHEMA_SCORE = "first-epss-score-csv-v1";
const SOURCE_SCHEMA_MANIFEST = "first-epss-dataset-manifest-v1";
const USER_AGENT = "BAYKUSH-Intelligence-Node/0.2 (+https://github.com/CenkCTI/BAYKUSH-Intel-Node)";

const cveSchema = z.string().regex(/^CVE-[0-9]{4}-[0-9]{4,19}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const decimal01SourceSchema = z.string().regex(/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/);

const captureProfileSchema = z.object({
  key: z.literal("EPSS_HIGH_SIGNAL_V1"),
  minimumEpss: z.literal(0.1),
  maximumRecords: z.literal(2_500),
  ordering: z.tuple([z.literal("epss_desc"), z.literal("percentile_desc"), z.literal("cve_asc")]),
}).strict();

const scorePayloadSchema = z.object({
  kind: z.literal("EPSS_SCORE"),
  cve: cveSchema,
  epss: decimal01SourceSchema,
  percentile: decimal01SourceSchema,
  scoreDate: dateSchema,
  modelVersion: z.string().min(1).max(128),
  datasetContentSha256: sha256Schema,
  captureProfile: captureProfileSchema,
  sourceExtras: z.record(z.string(), z.string()).optional(),
}).strict();

const manifestPayloadSchema = z.object({
  kind: z.literal("EPSS_DATASET_MANIFEST"),
  datasetDate: dateSchema,
  modelVersion: z.string().min(1).max(128),
  totalRows: z.number().int().positive().max(MAX_DATASET_ROWS),
  qualifiedRows: z.number().int().nonnegative().max(MAX_DATASET_ROWS),
  selectedRows: z.number().int().nonnegative().max(FIRST_EPSS_CAPTURE_PROFILE.maximumRecords),
  captureProfile: captureProfileSchema,
  compressedBytes: z.number().int().positive().max(MAX_COMPRESSED_BYTES),
  decompressedBytes: z.number().int().positive().max(MAX_DECOMPRESSED_BYTES),
  compressedArtifactSha256: sha256Schema,
  datasetContentSha256: sha256Schema,
  selectedPopulationSha256: sha256Schema,
  sourceHeader: z.string().min(1).max(MAX_METADATA_LINE_BYTES),
  http: z.object({
    etag: z.string().max(2_048).nullable(),
    lastModified: z.string().max(2_048).nullable(),
    finalUrl: z.string().url(),
    redirectChain: z.array(z.string().url()).max(3),
  }).strict(),
}).strict();

type ScorePayload = z.infer<typeof scorePayloadSchema>;
type ManifestPayload = z.infer<typeof manifestPayloadSchema>;

const persistedPayloadSchema = z.discriminatedUnion("kind", [scorePayloadSchema, manifestPayloadSchema]);

const checkpointSchema = z.object({
  version: z.literal(1),
  completedDatasetDate: dateSchema.nullable(),
  completedContentSha256: sha256Schema.nullable(),
  completedModelVersion: z.string().min(1).max(128).nullable(),
  previousTotalRows: z.number().int().positive().max(MAX_DATASET_ROWS).nullable(),
  etag: z.string().max(2_048).nullable(),
  lastModified: z.string().max(2_048).nullable(),
}).strict();
type FirstEpssCheckpoint = z.infer<typeof checkpointSchema>;

const workDescriptorSchema = z.object({
  version: z.literal(1),
  mode: z.literal("CURRENT"),
  previousDatasetDate: dateSchema.nullable(),
  previousContentSha256: sha256Schema.nullable(),
  previousModelVersion: z.string().min(1).max(128).nullable(),
  previousTotalRows: z.number().int().positive().max(MAX_DATASET_ROWS).nullable(),
  ifNoneMatch: z.string().max(2_048).nullable(),
  ifModifiedSince: z.string().max(2_048).nullable(),
}).strict();
type FirstEpssWorkDescriptor = z.infer<typeof workDescriptorSchema>;

const fetchedRecordSchema = z.object({
  kind: z.enum(["SCORE", "DATASET_MANIFEST"]),
  payload: persistedPayloadSchema,
  sourceUrl: z.string().url(),
}).strict();
type FirstEpssFetchedRecord = z.infer<typeof fetchedRecordSchema>;

interface EpssMetadata {
  modelVersion: string;
  datasetDate: string;
  normalizedScoreTimestamp: string;
  sourceHeader: string;
}

interface EpssCandidate {
  cve: string;
  epssSource: string;
  percentileSource: string;
  epss: number;
  percentile: number;
  sourceExtras: Record<string, string>;
}

export interface ParsedFirstEpssDataset {
  metadata: EpssMetadata;
  totalRows: number;
  qualifiedRows: number;
  selected: readonly EpssCandidate[];
  decompressedBytes: number;
  datasetContentSha256: string;
  selectedPopulationSha256: string;
}

interface FirstEpssAdapterOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  minimumEpss?: number;
  maximumRecords?: number;
  maxCompressedBytes?: number;
  maxDecompressedBytes?: number;
}

function decimal01(value: string, field: string): number {
  const source = decimal01SourceSchema.safeParse(value);
  if (!source.success) throw new CollectionFailure("SCHEMA_ERROR", `FIRST EPSS ${field} is not a decimal in [0,1]`, false);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new CollectionFailure("SCHEMA_ERROR", `FIRST EPSS ${field} is outside [0,1]`, false);
  }
  return parsed;
}

function normalizeScoreTimestamp(value: string): string {
  const trimmed = value.trim();
  const withTime = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const normalizedZone = withTime.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const milliseconds = Date.parse(normalizedZone);
  if (!Number.isFinite(milliseconds)) {
    throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS score_date metadata is not a valid timestamp", false);
  }
  return new Date(milliseconds).toISOString();
}

export function parseFirstEpssMetadataLine(line: string): EpssMetadata {
  const sourceHeader = line.replace(/^\uFEFF/, "").trim();
  if (!sourceHeader.startsWith("#")) {
    throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS dataset is missing its model metadata comment", false);
  }
  const fields = new Map<string, string>();
  for (const token of sourceHeader.slice(1).split(",")) {
    const separator = token.indexOf(":");
    if (separator <= 0) continue;
    fields.set(token.slice(0, separator).trim(), token.slice(separator + 1).trim());
  }
  const modelVersion = fields.get("model_version");
  const rawScoreDate = fields.get("score_date");
  if (!modelVersion || modelVersion.length > 128 || !rawScoreDate) {
    throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS model_version or score_date metadata is missing", false);
  }
  const normalizedScoreTimestamp = normalizeScoreTimestamp(rawScoreDate);
  return {
    modelVersion,
    datasetDate: normalizedScoreTimestamp.slice(0, 10),
    normalizedScoreTimestamp,
    sourceHeader,
  };
}

export function compareEpssCandidates(left: EpssCandidate, right: EpssCandidate): number {
  if (left.epss !== right.epss) return left.epss - right.epss;
  if (left.percentile !== right.percentile) return left.percentile - right.percentile;
  return right.cve.localeCompare(left.cve);
}

function createGzipMagicGuard(): Transform {
  let prefix = Buffer.alloc(0);
  let checked = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        if (!checked) {
          const needed = Math.max(0, 2 - prefix.length);
          if (needed > 0) prefix = Buffer.concat([prefix, chunk.subarray(0, needed)]);
          if (prefix.length >= 2) {
            checked = true;
            if (prefix[0] !== 0x1f || prefix[1] !== 0x8b) {
              callback(new CollectionFailure("PROVIDER_ERROR", "FIRST EPSS artifact is not gzip data", true));
              return;
            }
          }
        }
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
    flush(callback) {
      if (!checked) callback(new CollectionFailure("PROVIDER_ERROR", "FIRST EPSS gzip artifact is truncated", true));
      else callback();
    },
  });
}

function createDatasetTap(state: {
  maxBytes: number;
  bytes: number;
  hash: ReturnType<typeof createHash>;
  firstLine: Buffer;
  firstLineDone: boolean;
}): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        state.bytes += chunk.length;
        if (state.bytes > state.maxBytes) {
          callback(new CollectionFailure(
            "PAYLOAD_LIMIT_EXCEEDED",
            `FIRST EPSS dataset exceeds ${state.maxBytes} decompressed bytes`,
            false,
          ));
          return;
        }
        state.hash.update(chunk);
        if (!state.firstLineDone) {
          const newline = chunk.indexOf(0x0a);
          const slice = newline >= 0 ? chunk.subarray(0, newline) : chunk;
          state.firstLine = Buffer.concat([state.firstLine, slice]);
          if (state.firstLine.length > MAX_METADATA_LINE_BYTES) {
            callback(new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS metadata line exceeds its bound", false));
            return;
          }
          if (newline >= 0) state.firstLineDone = true;
        }
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

function sourceExtras(row: Record<string, string>): Record<string, string> {
  const extras: Record<string, string> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!["cve", "epss", "percentile"].includes(key)) extras[key] = value;
  }
  return extras;
}

function selectedPopulationFingerprint(selected: readonly EpssCandidate[]): string {
  const hash = createHash("sha256");
  for (const row of selected) hash.update(`${row.cve},${row.epssSource},${row.percentileSource}\n`);
  return hash.digest("hex");
}

function classifyParsingFailure(error: unknown): CollectionFailure {
  if (error instanceof CollectionFailure) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (["Z_DATA_ERROR", "Z_BUF_ERROR", "Z_STREAM_ERROR"].includes(code)) {
      return new CollectionFailure("PROVIDER_ERROR", "FIRST EPSS gzip artifact could not be decompressed", true, { cause: error });
    }
  }
  return new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS CSV failed dataset validation", false, { cause: error });
}

export async function parseFirstEpssArtifact(input: {
  stream: AsyncIterable<Buffer>;
  minimumEpss?: number;
  maximumRecords?: number;
  maxDecompressedBytes?: number;
}): Promise<ParsedFirstEpssDataset> {
  const minimumEpss = input.minimumEpss ?? FIRST_EPSS_CAPTURE_PROFILE.minimumEpss;
  const maximumRecords = input.maximumRecords ?? FIRST_EPSS_CAPTURE_PROFILE.maximumRecords;
  const maxDecompressedBytes = input.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  if (!Number.isFinite(minimumEpss) || minimumEpss < 0 || minimumEpss > 1) {
    throw new CollectionFailure("INTERNAL_ERROR", "FIRST EPSS capture threshold is invalid", false);
  }
  if (!Number.isInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 10_000) {
    throw new CollectionFailure("INTERNAL_ERROR", "FIRST EPSS capture record bound is invalid", false);
  }

  const datasetState = {
    maxBytes: maxDecompressedBytes,
    bytes: 0,
    hash: createHash("sha256"),
    firstLine: Buffer.alloc(0),
    firstLineDone: false,
  };
  const top = new BoundedTopK<EpssCandidate>(maximumRecords, compareEpssCandidates);
  const seenCves = new Set<string>();
  let totalRows = 0;
  let qualifiedRows = 0;
  let headerValidated = false;

  const source = Readable.from(input.stream);
  const magicGuard = createGzipMagicGuard();
  const gunzip = createGunzip();
  const datasetTap = createDatasetTap(datasetState);
  const parser = parse({
    bom: true,
    columns: true,
    comment: "#",
    skip_empty_lines: true,
    trim: true,
    max_record_size: MAX_CSV_RECORD_BYTES,
  });
  const pump = pipeline(source, magicGuard, gunzip, datasetTap, parser);
  void pump.catch(() => {});

  try {
    for await (const unknownRow of parser) {
      if (!unknownRow || typeof unknownRow !== "object" || Array.isArray(unknownRow)) {
        throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS CSV emitted a non-object row", false);
      }
      const row: Record<string, string> = {};
      for (const [key, value] of Object.entries(unknownRow as Record<string, unknown>)) {
        if (typeof value !== "string") throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS CSV row contains a non-string field", false);
        row[key] = value;
      }

      if (!headerValidated) {
        const columns = Object.keys(row);
        if (columns.length > MAX_COLUMNS || !["cve", "epss", "percentile"].every((column) => columns.includes(column))) {
          throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS CSV is missing required core columns or exceeds the column bound", false);
        }
        headerValidated = true;
      }

      totalRows += 1;
      if (totalRows > MAX_DATASET_ROWS) {
        throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `FIRST EPSS dataset exceeds ${MAX_DATASET_ROWS} rows`, false);
      }

      const cve = cveSchema.safeParse(row.cve);
      if (!cve.success) throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS row contains an invalid CVE identifier", false);
      if (seenCves.has(cve.data)) {
        throw new CollectionFailure("SCHEMA_ERROR", `FIRST EPSS dataset contains duplicate CVE ${cve.data}`, false);
      }
      seenCves.add(cve.data);
      const epssSource = row.epss;
      const percentileSource = row.percentile;
      if (epssSource === undefined || percentileSource === undefined) {
        throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS row omitted score fields", false);
      }
      const epss = decimal01(epssSource, "epss");
      const percentile = decimal01(percentileSource, "percentile");
      if (epss >= minimumEpss) {
        qualifiedRows += 1;
        top.offer({
          cve: cve.data,
          epssSource,
          percentileSource,
          epss,
          percentile,
          sourceExtras: sourceExtras(row),
        });
      }
    }
    await pump;
  } catch (error) {
    source.destroy();
    magicGuard.destroy();
    gunzip.destroy();
    datasetTap.destroy();
    parser.destroy();
    try { await pump; } catch { /* original error is classified below */ }
    throw classifyParsingFailure(error);
  }

  if (!datasetState.firstLineDone) throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS dataset metadata line is incomplete", false);
  if (!headerValidated || totalRows === 0) throw new CollectionFailure("SCHEMA_ERROR", "FIRST EPSS dataset contained no score rows", false);
  const metadata = parseFirstEpssMetadataLine(datasetState.firstLine.toString("utf8").replace(/\r$/, ""));
  const selected = top.valuesBestFirst();
  return {
    metadata,
    totalRows,
    qualifiedRows,
    selected,
    decompressedBytes: datasetState.bytes,
    datasetContentSha256: datasetState.hash.digest("hex"),
    selectedPopulationSha256: selectedPopulationFingerprint(selected),
  };
}

function scoreDateInstant(scoreDate: string): string {
  return `${dateSchema.parse(scoreDate)}T00:00:00.000Z`;
}

function canonicalCaptureProfile() {
  return {
    key: FIRST_EPSS_CAPTURE_PROFILE.key,
    minimumEpss: FIRST_EPSS_CAPTURE_PROFILE.minimumEpss,
    maximumRecords: FIRST_EPSS_CAPTURE_PROFILE.maximumRecords,
    ordering: [...FIRST_EPSS_CAPTURE_PROFILE.ordering] as ["epss_desc", "percentile_desc", "cve_asc"],
  };
}

export function normalizeFirstEpssPayload(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "EPSS_DATASET_MANIFEST") return [];
  const epss = decimal01(payload.epss, "epss");
  const percentile = decimal01(payload.percentile, "percentile");
  return [{
    recordKind: "EXPLOIT_PROBABILITY_SCORE",
    canonicalKey: `epss:${payload.cve}`,
    entities: [{ kind: "CVE", key: payload.cve, label: payload.cve }],
    facts: [
      { predicate: "epss.score", value: epss },
      { predicate: "epss.percentile", value: percentile },
      { predicate: "epss.score_date", value: payload.scoreDate },
      { predicate: "epss.score_date_precision", value: "DATE" },
      { predicate: "epss.model_version", value: payload.modelVersion },
      { predicate: "epss.dataset_content_sha256", value: payload.datasetContentSha256 },
      { predicate: "baykush.capture_profile", value: payload.captureProfile.key },
      { predicate: "baykush.capture_minimum_epss", value: payload.captureProfile.minimumEpss },
      { predicate: "baykush.capture_max_records", value: payload.captureProfile.maximumRecords },
    ],
    references: [FIRST_EPSS_CURRENT_URL.toString()],
  }];
}

function checkpointFromDataset(input: {
  parsed: ParsedFirstEpssDataset;
  etag: string | null;
  lastModified: string | null;
}): FirstEpssCheckpoint {
  return checkpointSchema.parse({
    version: 1,
    completedDatasetDate: input.parsed.metadata.datasetDate,
    completedContentSha256: input.parsed.datasetContentSha256,
    completedModelVersion: input.parsed.metadata.modelVersion,
    previousTotalRows: input.parsed.totalRows,
    etag: input.etag,
    lastModified: input.lastModified,
  });
}

export function createFirstEpssAdapter(options: FirstEpssAdapterOptions = {}): SourceAdapter {
  const minimumEpss = options.minimumEpss ?? FIRST_EPSS_CAPTURE_PROFILE.minimumEpss;
  const maximumRecords = options.maximumRecords ?? FIRST_EPSS_CAPTURE_PROFILE.maximumRecords;
  const maxCompressedBytes = options.maxCompressedBytes ?? MAX_COMPRESSED_BYTES;
  const maxDecompressedBytes = options.maxDecompressedBytes ?? MAX_DECOMPRESSED_BYTES;
  const fetchImpl = options.fetchImpl;
  void options.now;

  return {
    definition: {
      sourceKey: "FIRST_EPSS",
      displayName: "FIRST EPSS Daily Scores",
      providerName: "FIRST Exploit Prediction Scoring System",
      upstreamOriginKey: "FIRST_EPSS",
      sourceClass: "EXPLOIT_PROBABILITY",
      observationBasis: "SCORED",
      authorityType: "INDUSTRY_SCORING_SYSTEM",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 21_600,
      minimumPollIntervalSeconds: 3_600,
      supportsHistoricalRetrieval: true,
      recoveryStrategy: "HISTORICAL_QUERY",
      historicalMaxWindowSeconds: 86_400,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "first-epss-adapter-v1",
      semanticContractVersion: "first-epss-semantics-v1",
      licenseClass: "FIRST-EPSS-PUBLIC-DATA",
      commercialUseStatus: "UNKNOWN",
      redistributionStatus: "UNKNOWN",
      attributionRequirement: "EPSS scores are published freely by the FIRST EPSS SIG; attribution is requested when EPSS data is used in products or publications.",
      termsReference: "https://www.first.org/about/policies/terms",
      semanticBoundary: {
        represents: "FIRST EPSS daily CVE exploitation-probability scores and percentiles for the source score date, retained under an explicit BAYKUSH bounded capture profile.",
        doesNotRepresent: "Observed exploitation events, attack or victim counts, active exploitation proof, severity, CVSS, asset exposure, business impact, business risk, remediation priority, BAYKUSH Global Priority, or a current threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: maximumRecords + 1,
    maxRawRecordBytes: MAX_RAW_RECORD_BYTES,
    normalizationVersion: "first-epss-normalization-v1",
    checkpointSchemaVersion: "first-epss-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema,
    plan({ checkpoint }) {
      const parsed = checkpoint === null ? null : checkpointSchema.parse(checkpoint);
      return workDescriptorSchema.parse({
        version: 1,
        mode: "CURRENT",
        previousDatasetDate: parsed?.completedDatasetDate ?? null,
        previousContentSha256: parsed?.completedContentSha256 ?? null,
        previousModelVersion: parsed?.completedModelVersion ?? null,
        previousTotalRows: parsed?.previousTotalRows ?? null,
        ifNoneMatch: parsed?.etag ?? null,
        ifModifiedSince: parsed?.lastModified ?? null,
      });
    },
    async fetch({ work, signal }) {
      const descriptor: FirstEpssWorkDescriptor = workDescriptorSchema.parse(work);
      const headers: Record<string, string> = {
        accept: "application/gzip, application/x-gzip, application/octet-stream",
        "user-agent": USER_AGENT,
      };
      if (descriptor.ifNoneMatch) headers["if-none-match"] = descriptor.ifNoneMatch;
      if (descriptor.ifModifiedSince) headers["if-modified-since"] = descriptor.ifModifiedSince;

      const artifact = await fetchBoundedArtifact({
        url: FIRST_EPSS_CURRENT_URL,
        allowedEndpoints: [
          { hostname: "epss.empiricalsecurity.com", path: /^\/epss_scores-current\.csv\.gz$/ },
          { hostname: "epss.empiricalsecurity.com", path: /^\/epss_scores-\d{4}-\d{2}-\d{2}\.csv\.gz$/ },
        ],
        maxRedirects: 3,
        maxCompressedBytes,
        timeoutMs: config.sourceHttpTimeoutMs,
        acceptedContentTypes: ["application/gzip", "application/x-gzip", "application/octet-stream", "binary/octet-stream"],
        headers,
        ...(fetchImpl ? { fetchImpl } : {}),
        signal,
        consume: async ({ stream }) => parseFirstEpssArtifact({
          stream,
          minimumEpss,
          maximumRecords,
          maxDecompressedBytes,
        }),
      });

      if (artifact.status === 304) {
        if (!descriptor.previousDatasetDate || !descriptor.previousContentSha256) {
          throw new CollectionFailure("PROVIDER_ERROR", "FIRST EPSS returned 304 without a completed local dataset", true);
        }
        return {
          records: [],
          nextWork: null,
          nextCheckpoint: checkpointSchema.parse({
            version: 1,
            completedDatasetDate: descriptor.previousDatasetDate,
            completedContentSha256: descriptor.previousContentSha256,
            completedModelVersion: descriptor.previousModelVersion,
            previousTotalRows: descriptor.previousTotalRows,
            etag: artifact.etag ?? descriptor.ifNoneMatch,
            lastModified: artifact.lastModified ?? descriptor.ifModifiedSince,
          }),
          complete: true,
        };
      }

      const parsed = artifact.value;
      if (!parsed || !artifact.compressedSha256 || artifact.compressedBytes <= 0) {
        throw new CollectionFailure("PROVIDER_ERROR", "FIRST EPSS artifact produced no parsed dataset", true);
      }
      if (descriptor.previousDatasetDate && parsed.metadata.datasetDate < descriptor.previousDatasetDate) {
        throw new CollectionFailure("SOURCE_SNAPSHOT_CHANGED", "FIRST EPSS current dataset date regressed behind the completed checkpoint", true);
      }
      if (
        descriptor.previousTotalRows !== null &&
        descriptor.previousModelVersion === parsed.metadata.modelVersion &&
        parsed.totalRows < Math.floor(descriptor.previousTotalRows * SAME_MODEL_ROW_DROP_RATIO)
      ) {
        throw new CollectionFailure("SOURCE_SNAPSHOT_CHANGED", "FIRST EPSS dataset population dropped unexpectedly under the same model version", true);
      }

      const nextCheckpoint = checkpointFromDataset({ parsed, etag: artifact.etag, lastModified: artifact.lastModified });
      if (
        descriptor.previousDatasetDate === parsed.metadata.datasetDate &&
        descriptor.previousContentSha256 === parsed.datasetContentSha256
      ) {
        return { records: [], nextWork: null, nextCheckpoint, complete: true };
      }

      const sourceUrl = artifact.finalUrl;
      const captureProfile = canonicalCaptureProfile();
      const manifest: ManifestPayload = manifestPayloadSchema.parse({
        kind: "EPSS_DATASET_MANIFEST",
        datasetDate: parsed.metadata.datasetDate,
        modelVersion: parsed.metadata.modelVersion,
        totalRows: parsed.totalRows,
        qualifiedRows: parsed.qualifiedRows,
        selectedRows: parsed.selected.length,
        captureProfile,
        compressedBytes: artifact.compressedBytes,
        decompressedBytes: parsed.decompressedBytes,
        compressedArtifactSha256: artifact.compressedSha256,
        datasetContentSha256: parsed.datasetContentSha256,
        selectedPopulationSha256: parsed.selectedPopulationSha256,
        sourceHeader: parsed.metadata.sourceHeader,
        http: {
          etag: artifact.etag,
          lastModified: artifact.lastModified,
          finalUrl: sourceUrl,
          redirectChain: [...artifact.redirectChain],
        },
      });

      const records: FirstEpssFetchedRecord[] = [{
        kind: "DATASET_MANIFEST",
        payload: manifest,
        sourceUrl,
      }];
      for (const selected of parsed.selected) {
        const extras = Object.keys(selected.sourceExtras).length ? selected.sourceExtras : undefined;
        const payload: ScorePayload = scorePayloadSchema.parse({
          kind: "EPSS_SCORE",
          cve: selected.cve,
          epss: selected.epssSource,
          percentile: selected.percentileSource,
          scoreDate: parsed.metadata.datasetDate,
          modelVersion: parsed.metadata.modelVersion,
          datasetContentSha256: parsed.datasetContentSha256,
          captureProfile,
          ...(extras ? { sourceExtras: extras } : {}),
        });
        records.push({ kind: "SCORE", payload, sourceUrl });
      }

      return { records, nextWork: null, nextCheckpoint, complete: true };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.payload.kind === "EPSS_DATASET_MANIFEST" ? "dataset-manifest" : parsed.payload.cve;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record).payload;
      const scoreDate = parsed.kind === "EPSS_DATASET_MANIFEST" ? parsed.datasetDate : parsed.scoreDate;
      const instant = scoreDateInstant(scoreDate);
      return { publishedAt: instant, effectiveAt: instant, upstreamUpdatedAt: null };
    },
    sourceReference(record) {
      return fetchedRecordSchema.parse(record).sourceUrl;
    },
    sourceSchemaVersion(record) {
      const parsed = fetchedRecordSchema.parse(record).payload;
      return parsed.kind === "EPSS_DATASET_MANIFEST" ? SOURCE_SCHEMA_MANIFEST : SOURCE_SCHEMA_SCORE;
    },
    rawPayload(record) {
      return fetchedRecordSchema.parse(record).payload;
    },
    normalize(record) {
      return normalizeFirstEpssPayload(record);
    },
    classifyFailure(error) {
      if (error instanceof z.ZodError) {
        return { code: "SCHEMA_ERROR", retryable: false, message: "FIRST EPSS data failed validation" };
      }
      return classifyUnknownFailure(error);
    },
  };
}

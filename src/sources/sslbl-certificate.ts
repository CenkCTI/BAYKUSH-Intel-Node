import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedSource } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

export const SSLBL_CERTIFICATE_CSV_URL = new URL("https://sslbl.abuse.ch/blacklist/sslblacklist.csv");
export const SSLBL_PUBLIC_REFERENCE = "https://sslbl.abuse.ch/blacklist/";

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 25_000;
const MAX_RAW_RECORD_BYTES = 64 * 1024;
const SOURCE_SCHEMA_RECORD = "sslbl-certificate-csv-v1";
const SOURCE_SCHEMA_MANIFEST = "sslbl-certificate-manifest-v1";

const timestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).max(32);
const sha1Schema = z.string().regex(/^[a-fA-F0-9]{40}$/).transform((value) => value.toLowerCase());

const recordSchema = z.object({
  listingDate: timestampSchema,
  sha1: sha1Schema,
  listingReason: z.string().min(1).max(2_048),
}).strict();
type SslblCertificateRecord = z.infer<typeof recordSchema>;

const persistedRecordSchema = z.object({ kind: z.literal("SSLBL_CERTIFICATE"), source: recordSchema }).strict();
const manifestSchema = z.object({
  kind: z.literal("SSLBL_CERTIFICATE_MANIFEST"),
  recordCount: z.number().int().nonnegative().max(MAX_RECORDS),
  responseBytes: z.number().int().nonnegative().max(MAX_RESPONSE_BYTES),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  sourceLastUpdated: z.string().datetime({ offset: true }).nullable(),
  minListingAt: z.string().datetime({ offset: true }).nullable(),
  maxListingAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const persistedPayloadSchema = z.discriminatedUnion("kind", [persistedRecordSchema, manifestSchema]);
const fetchedRecordSchema = z.object({ kind: z.enum(["ENTRY", "MANIFEST"]), payload: persistedPayloadSchema }).strict();
const checkpointSchema = z.object({
  version: z.literal(1),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recordCount: z.number().int().nonnegative().max(MAX_RECORDS).nullable(),
  sourceLastUpdated: z.string().datetime({ offset: true }).nullable(),
}).strict();
type SslblCheckpoint = z.infer<typeof checkpointSchema>;

interface SslblCertificateAdapterOptions {
  fetchImpl?: typeof fetch;
  url?: URL;
  maxResponseBytes?: number;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function parseSslblTimestamp(value: string): string {
  if (!timestampSchema.safeParse(value).success) {
    throw new CollectionFailure("SCHEMA_ERROR", "SSLBL timestamp is outside the documented UTC format", false);
  }
  const iso = `${value.slice(0, 10)}T${value.slice(11, 19)}.000Z`;
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== iso) {
    throw new CollectionFailure("SCHEMA_ERROR", "SSLBL timestamp is not a valid UTC instant", false);
  }
  return iso;
}

function parseSourceLastUpdated(text: string): string | null {
  const match = /^# Last updated:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC\s*$/m.exec(text);
  return match?.[1] ? parseSslblTimestamp(match[1]) : null;
}

export function parseSslblCertificateCsv(text: string): SslblCertificateRecord[] {
  let rows: unknown[];
  try {
    rows = parse(text, {
      comment: "#",
      relax_column_count: false,
      skip_empty_lines: true,
      trim: true,
      columns: false,
      max_record_size: 16 * 1024,
    }) as unknown[];
  } catch (error) {
    throw new CollectionFailure("SCHEMA_ERROR", "SSLBL certificate CSV could not be parsed", false, { cause: error });
  }
  if (rows.length > MAX_RECORDS) throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", "SSLBL certificate CSV exceeds record bound", false);
  return rows.map((row, index) => {
    if (!Array.isArray(row) || row.length !== 3) {
      throw new CollectionFailure("SCHEMA_ERROR", `SSLBL certificate row ${index + 1} has an unexpected column count`, false);
    }
    return recordSchema.parse({ listingDate: row[0], sha1: row[1], listingReason: row[2] });
  });
}

function snapshotFingerprint(records: readonly SslblCertificateRecord[]): string {
  const members = records.map((record) => `${record.sha1}:${sha256(canonicalJsonStringify(record))}`);
  members.sort();
  return sha256(members.join("\n"));
}

function emptyCheckpoint(): SslblCheckpoint {
  return { version: 1, snapshotFingerprint: null, responseSha256: null, recordCount: null, sourceLastUpdated: null };
}

export function normalizeSslblCertificate(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "SSLBL_CERTIFICATE_MANIFEST") return [];
  const source = payload.source;
  const listingAt = parseSslblTimestamp(source.listingDate);
  return [{
    recordKind: "IOC_REPORT",
    canonicalKey: `ioc:sslbl-certificate:sha1:${source.sha1}`,
    entities: [{ kind: "CERTIFICATE", key: `sha1:${source.sha1}`, label: source.sha1 }],
    facts: [
      { predicate: "sslbl.certificate_sha1", value: source.sha1 },
      { predicate: "sslbl.listing_at", value: listingAt },
      { predicate: "sslbl.listing_reason", value: source.listingReason },
    ],
    references: [SSLBL_PUBLIC_REFERENCE],
  }];
}

export function createSslblCertificateAdapter(options: SslblCertificateAdapterOptions = {}): SourceAdapter {
  const url = options.url ?? SSLBL_CERTIFICATE_CSV_URL;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return {
    definition: {
      sourceKey: "SSLBL_CERTIFICATE",
      displayName: "SSLBL Malicious SSL Certificates",
      providerName: "abuse.ch",
      upstreamOriginKey: "SSLBL",
      sourceClass: "IOC_SHARING",
      observationBasis: "REPORTED",
      authorityType: "THREAT_FEED_PROVIDER",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 900,
      minimumPollIntervalSeconds: 300,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "SNAPSHOT_RECONSTRUCTION",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "sslbl-certificate-adapter-v1",
      semanticContractVersion: "sslbl-certificate-semantics-v1",
      licenseClass: "CC0-1.0",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "CC0 does not require attribution; retain an SSLBL source reference and do not imply abuse.ch endorsement.",
      termsReference: SSLBL_PUBLIC_REFERENCE,
      semanticBoundary: {
        represents: "SHA1 certificate fingerprints published by SSLBL as associated with malicious or botnet command-and-control activity, with SSLBL listing time and reason.",
        doesNotRepresent: "Global TLS activity, certificate compromise proof, BAYKUSH sensor observations, attack count, victim count, infection count, organization compromise, attribution truth, or global threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_RECORDS,
    maxRawRecordBytes: MAX_RAW_RECORD_BYTES,
    normalizationVersion: "sslbl-certificate-normalization-v1",
    checkpointSchemaVersion: "sslbl-certificate-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) { return checkpoint === null ? emptyCheckpoint() : checkpointSchema.parse(checkpoint); },
    async fetch({ work, signal }) {
      const checkpoint = checkpointSchema.parse(work);
      const response = await fetchBoundedSource({
        url,
        allowedHost: url.hostname,
        allowedPath: url.pathname,
        maxBytes: maxResponseBytes,
        timeoutMs: 20_000,
        signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      const text = response.bytes.toString("utf8");
      const records = parseSslblCertificateCsv(text);
      const responseSha256 = sha256(response.bytes);
      const fingerprint = snapshotFingerprint(records);
      const sourceLastUpdated = parseSourceLastUpdated(text);
      const listingTimes = records.map((record) => parseSslblTimestamp(record.listingDate)).sort();
      const manifest = manifestSchema.parse({
        kind: "SSLBL_CERTIFICATE_MANIFEST",
        recordCount: records.length,
        responseBytes: response.bytes.length,
        responseSha256,
        snapshotFingerprint: fingerprint,
        sourceLastUpdated,
        minListingAt: listingTimes[0] ?? null,
        maxListingAt: listingTimes.at(-1) ?? null,
      });
      const nextCheckpoint: SslblCheckpoint = { version: 1, snapshotFingerprint: fingerprint, responseSha256, recordCount: records.length, sourceLastUpdated };
      if (checkpoint.snapshotFingerprint === fingerprint) return { records: [], nextWork: null, nextCheckpoint, complete: true };
      return {
        records: [
          ...records.map((source) => ({ kind: "ENTRY" as const, payload: { kind: "SSLBL_CERTIFICATE" as const, source } })),
          { kind: "MANIFEST" as const, payload: manifest },
        ],
        nextWork: null,
        nextCheckpoint,
        complete: true,
      };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") return "__certificate_manifest__";
      if (parsed.payload.kind !== "SSLBL_CERTIFICATE") throw new CollectionFailure("SCHEMA_ERROR", "SSLBL certificate entry has invalid payload kind", false);
      return `sha1:${parsed.payload.source.sha1}`;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") {
        const timestamp = parsed.payload.kind === "SSLBL_CERTIFICATE_MANIFEST" ? parsed.payload.sourceLastUpdated : null;
        return { publishedAt: timestamp, effectiveAt: timestamp, upstreamUpdatedAt: null };
      }
      if (parsed.payload.kind !== "SSLBL_CERTIFICATE") throw new CollectionFailure("SCHEMA_ERROR", "SSLBL certificate entry has invalid payload kind", false);
      const listingAt = parseSslblTimestamp(parsed.payload.source.listingDate);
      return { publishedAt: listingAt, effectiveAt: listingAt, upstreamUpdatedAt: null };
    },
    sourceReference() { return SSLBL_PUBLIC_REFERENCE; },
    sourceSchemaVersion(record) { return fetchedRecordSchema.parse(record).kind === "MANIFEST" ? SOURCE_SCHEMA_MANIFEST : SOURCE_SCHEMA_RECORD; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeSslblCertificate(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "SSLBL certificate data failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

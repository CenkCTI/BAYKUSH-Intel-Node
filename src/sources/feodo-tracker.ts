import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

export const FEODO_TRACKER_JSON_URL = new URL("https://feodotracker.abuse.ch/downloads/ipblocklist.json");
export const FEODO_TRACKER_PUBLIC_REFERENCE = "https://feodotracker.abuse.ch/blocklist/";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_RAW_RECORD_BYTES = 64 * 1024;
const SOURCE_SCHEMA_RECORD = "feodo-c2-ioc-json-v1";
const SOURCE_SCHEMA_MANIFEST = "feodo-c2-snapshot-manifest-v1";

const utcTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/).max(32);
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).max(16);

export const feodoRecordSchema = z.object({
  ip_address: z.string().refine((value) => isIP(value) === 4, "Feodo ip_address must be IPv4"),
  port: z.number().int().min(1).max(65_535),
  status: z.string().min(1).max(64),
  hostname: z.string().min(1).max(1_024).nullable(),
  as_number: z.number().int().nonnegative().max(4_294_967_295),
  as_name: z.string().min(1).max(1_024),
  country: z.string().regex(/^[A-Z]{2}$/),
  first_seen: utcTimestampSchema,
  last_online: dateOnlySchema,
  malware: z.string().min(1).max(256),
}).passthrough();
export type FeodoRecord = z.infer<typeof feodoRecordSchema>;

const sourceArraySchema = z.array(feodoRecordSchema).max(MAX_RECORDS);
const persistedEntrySchema = z.object({ kind: z.literal("FEODO_C2_IOC"), source: feodoRecordSchema }).strict();
const manifestSchema = z.object({
  kind: z.literal("FEODO_SNAPSHOT_MANIFEST"),
  dataset: z.literal("BOTNET_C2_IOCS"),
  recordCount: z.number().int().nonnegative().max(MAX_RECORDS),
  responseBytes: z.number().int().nonnegative().max(MAX_RESPONSE_BYTES),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  minFirstSeen: z.string().datetime({ offset: true }).nullable(),
  maxFirstSeen: z.string().datetime({ offset: true }).nullable(),
}).strict();
const persistedPayloadSchema = z.discriminatedUnion("kind", [persistedEntrySchema, manifestSchema]);
const fetchedRecordSchema = z.object({ kind: z.enum(["ENTRY", "MANIFEST"]), payload: persistedPayloadSchema }).strict();
const checkpointSchema = z.object({
  version: z.literal(1),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  recordCount: z.number().int().nonnegative().max(MAX_RECORDS).nullable(),
}).strict();
type FeodoCheckpoint = z.infer<typeof checkpointSchema>;

interface FeodoAdapterOptions { fetchImpl?: typeof fetch; url?: URL; maxResponseBytes?: number; }

function sha256(input: string | Buffer): string { return createHash("sha256").update(input).digest("hex"); }

export function parseFeodoUtcTimestamp(value: string): string {
  if (!utcTimestampSchema.safeParse(value).success) throw new CollectionFailure("SCHEMA_ERROR", "Feodo first_seen is outside the expected UTC format", false);
  const iso = `${value.slice(0, 10)}T${value.slice(11, 19)}.000Z`;
  const millis = Date.parse(iso);
  if (!Number.isFinite(millis) || new Date(millis).toISOString() !== iso) throw new CollectionFailure("SCHEMA_ERROR", "Feodo first_seen is not a valid UTC instant", false);
  return iso;
}

function sourceIdentity(record: FeodoRecord): string {
  return sha256(canonicalJsonStringify({ ip: record.ip_address, port: record.port, malware: record.malware, firstSeen: record.first_seen }));
}

function snapshotFingerprint(records: readonly FeodoRecord[]): string {
  const members = records.map((record) => ({ id: sourceIdentity(record), hash: sha256(canonicalJsonStringify(record)) }));
  members.sort((left, right) => left.id.localeCompare(right.id));
  return sha256(members.map((entry) => `${entry.id}:${entry.hash}\n`).join(""));
}

function emptyCheckpoint(): FeodoCheckpoint { return { version: 1, snapshotFingerprint: null, responseSha256: null, recordCount: null }; }

export function normalizeFeodoRecord(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "FEODO_SNAPSHOT_MANIFEST") return [];
  const source = payload.source;
  const firstSeen = parseFeodoUtcTimestamp(source.first_seen);
  const identity = sourceIdentity(source);
  const malwareLabel = source.malware.trim();
  return [{
    recordKind: "IOC_REPORT",
    canonicalKey: `ioc:feodo-c2:${identity}`,
    entities: [
      { kind: "IP", key: source.ip_address, label: source.ip_address },
      { kind: "MALWARE", key: `feodo-label:${malwareLabel.toLowerCase().replace(/\s+/g, "-")}`, label: malwareLabel },
    ],
    facts: [
      { predicate: "feodo.ip_address", value: source.ip_address },
      { predicate: "feodo.port", value: source.port },
      { predicate: "feodo.status", value: source.status },
      { predicate: "feodo.hostname", value: source.hostname },
      { predicate: "feodo.as_number", value: source.as_number },
      { predicate: "feodo.as_name", value: source.as_name },
      { predicate: "feodo.country", value: source.country },
      { predicate: "feodo.first_seen", value: firstSeen },
      { predicate: "feodo.last_online_date", value: source.last_online },
      { predicate: "feodo.malware_label", value: malwareLabel },
      { predicate: "feodo.endpoint_identity", value: identity },
    ],
    references: [FEODO_TRACKER_PUBLIC_REFERENCE],
  }];
}

export function createFeodoTrackerAdapter(options: FeodoAdapterOptions = {}): SourceAdapter {
  const url = options.url ?? FEODO_TRACKER_JSON_URL;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return {
    definition: {
      sourceKey: "FEODO_TRACKER",
      displayName: "Feodo Tracker Botnet C2 IOCs",
      providerName: "abuse.ch",
      upstreamOriginKey: "FEODO_TRACKER",
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
      adapterVersion: "feodo-tracker-adapter-v1",
      semanticContractVersion: "feodo-tracker-semantics-v1",
      licenseClass: "CC0-1.0",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "CC0 does not require attribution; retain the Feodo Tracker source reference and do not imply abuse.ch endorsement.",
      termsReference: FEODO_TRACKER_PUBLIC_REFERENCE,
      semanticBoundary: {
        represents: "Botnet command-and-control IOC records published by Feodo Tracker in its non-aggressive Botnet C2 IOC dataset.",
        doesNotRepresent: "BAYKUSH sensor observations, attack count, victim count, infection count, bot population, organization compromise, current global maliciousness, attribution truth, or global threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_RECORDS,
    maxRawRecordBytes: MAX_RAW_RECORD_BYTES,
    normalizationVersion: "feodo-tracker-normalization-v1",
    checkpointSchemaVersion: "feodo-tracker-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) { return checkpoint === null ? emptyCheckpoint() : checkpointSchema.parse(checkpoint); },
    async fetch({ work, signal }) {
      const checkpoint = checkpointSchema.parse(work);
      const response = await fetchBoundedJson({
        url, allowedHost: url.hostname, allowedPath: url.pathname, maxBytes: maxResponseBytes, timeoutMs: 15_000, signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (response.json === null) throw new CollectionFailure("PROVIDER_ERROR", "Feodo Tracker returned an empty HTTP body", true);
      const records = sourceArraySchema.parse(response.json);
      const responseSha256 = sha256(response.bytes);
      const fingerprint = snapshotFingerprint(records);
      const firstSeenValues = records.map((record) => parseFeodoUtcTimestamp(record.first_seen)).sort();
      const manifest = manifestSchema.parse({
        kind: "FEODO_SNAPSHOT_MANIFEST", dataset: "BOTNET_C2_IOCS", recordCount: records.length,
        responseBytes: response.bytes.length, responseSha256, snapshotFingerprint: fingerprint,
        minFirstSeen: firstSeenValues[0] ?? null, maxFirstSeen: firstSeenValues.at(-1) ?? null,
      });
      const nextCheckpoint: FeodoCheckpoint = { version: 1, snapshotFingerprint: fingerprint, responseSha256, recordCount: records.length };
      if (checkpoint.snapshotFingerprint === fingerprint) return { records: [], nextWork: null, nextCheckpoint, complete: true };
      return {
        records: [
          ...records.map((source) => ({ kind: "ENTRY" as const, payload: { kind: "FEODO_C2_IOC" as const, source } })),
          { kind: "MANIFEST" as const, payload: manifest },
        ],
        nextWork: null, nextCheckpoint, complete: true,
      };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") return "__snapshot_manifest__";
      if (parsed.payload.kind !== "FEODO_C2_IOC") throw new CollectionFailure("SCHEMA_ERROR", "Feodo entry has an invalid payload kind", false);
      return `c2:${sourceIdentity(parsed.payload.source)}`;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
      if (parsed.payload.kind !== "FEODO_C2_IOC") throw new CollectionFailure("SCHEMA_ERROR", "Feodo entry has an invalid payload kind", false);
      return { publishedAt: null, effectiveAt: parseFeodoUtcTimestamp(parsed.payload.source.first_seen), upstreamUpdatedAt: null };
    },
    sourceReference() { return FEODO_TRACKER_PUBLIC_REFERENCE; },
    sourceSchemaVersion(record) { return fetchedRecordSchema.parse(record).kind === "MANIFEST" ? SOURCE_SCHEMA_MANIFEST : SOURCE_SCHEMA_RECORD; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeFeodoRecord(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "Feodo Tracker data failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

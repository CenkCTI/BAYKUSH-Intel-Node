import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { z } from "zod";
import { config } from "../config.js";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

export const THREATFOX_API_URL = new URL("https://threatfox-api.abuse.ch/api/v1/");

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_IOCS_PER_QUERY = 9_999;
const MAX_RAW_RECORD_BYTES = 256 * 1024;
const DAY_MS = 86_400_000;
const USER_AGENT = "BAYKUSH-Intelligence-Node/0.2 (+https://github.com/CenkCTI/BAYKUSH-Intel-Node)";
const SOURCE_SCHEMA_IOC = "threatfox-recent-ioc-v1";
const SOURCE_SCHEMA_MANIFEST = "threatfox-query-manifest-v1";

const threatFoxTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/).max(64);

const threatFoxIocSchema = z.object({
  id: z.string().regex(/^\d+$/).max(64),
  ioc: z.string().min(1).max(4_096),
  threat_type: z.string().min(1).max(128),
  threat_type_desc: z.string().max(2_048).nullable().optional(),
  ioc_type: z.string().min(1).max(128),
  ioc_type_desc: z.string().max(2_048).nullable().optional(),
  malware: z.string().max(256).nullable().optional(),
  malware_printable: z.string().max(512).nullable().optional(),
  malware_alias: z.string().max(2_048).nullable().optional(),
  malware_malpedia: z.string().max(4_096).nullable().optional(),
  confidence_level: z.number().int().min(0).max(100),
  first_seen: threatFoxTimestampSchema,
  last_seen: threatFoxTimestampSchema.nullable(),
  reporter: z.string().max(512).nullable().optional(),
  reference: z.string().max(4_096).nullable().optional(),
  tags: z.array(z.string().max(256)).max(256).nullable().optional(),
  is_compromised: z.union([z.boolean(), z.number().int().min(0).max(1), z.enum(["0", "1"])]).nullable().optional(),
}).passthrough();

type ThreatFoxIoc = z.infer<typeof threatFoxIocSchema>;

const responseEnvelopeSchema = z.object({
  query_status: z.string().min(1).max(128),
  data: z.unknown().optional(),
}).passthrough();

const iocPayloadSchema = z.object({
  kind: z.literal("THREATFOX_IOC"),
  source: threatFoxIocSchema,
}).strict();

const manifestPayloadSchema = z.object({
  kind: z.literal("THREATFOX_QUERY_MANIFEST"),
  query: z.literal("get_iocs"),
  days: z.number().int().min(1).max(7),
  queryStatus: z.literal("ok"),
  recordCount: z.number().int().nonnegative().max(MAX_IOCS_PER_QUERY),
  responseBytes: z.number().int().nonnegative().max(MAX_RESPONSE_BYTES),
  responseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  minFirstSeen: z.string().datetime({ offset: true }).nullable(),
  maxFirstSeen: z.string().datetime({ offset: true }).nullable(),
  recoveryGapExceeded: z.boolean(),
}).strict();

type ThreatFoxManifest = z.infer<typeof manifestPayloadSchema>;

const persistedPayloadSchema = z.discriminatedUnion("kind", [iocPayloadSchema, manifestPayloadSchema]);

const checkpointSchema = z.object({
  version: z.literal(1),
  lastSuccessfulCollectionAt: z.string().datetime({ offset: true }).nullable(),
  lastSnapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  lastResponseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  previousRecordCount: z.number().int().nonnegative().max(MAX_IOCS_PER_QUERY).nullable(),
  maxFirstSeen: z.string().datetime({ offset: true }).nullable(),
  recoveryWindowDays: z.number().int().min(1).max(7),
  recoveryGapExceeded: z.boolean(),
}).strict();

type ThreatFoxCheckpoint = z.infer<typeof checkpointSchema>;

const workDescriptorSchema = z.object({
  version: z.literal(1),
  mode: z.literal("RECENT_IOCS"),
  days: z.number().int().min(1).max(7),
  recoveryGapExceeded: z.boolean(),
  previousSnapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  previousResponseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  previousRecordCount: z.number().int().nonnegative().max(MAX_IOCS_PER_QUERY).nullable(),
  previousRecoveryWindowDays: z.number().int().min(1).max(7).nullable(),
  previousRecoveryGapExceeded: z.boolean().nullable(),
}).strict();

type ThreatFoxWorkDescriptor = z.infer<typeof workDescriptorSchema>;

const fetchedRecordSchema = z.object({
  kind: z.enum(["IOC", "QUERY_MANIFEST"]),
  payload: persistedPayloadSchema,
}).strict();

type ThreatFoxFetchedRecord = z.infer<typeof fetchedRecordSchema>;

interface ThreatFoxAdapterOptions {
  authKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxResponseBytes?: number;
}

interface IndicatorNormalization {
  status: "NORMALIZED" | "UNMAPPED" | "INVALID_SOURCE_VALUE";
  entity: { kind: "IP" | "DOMAIN" | "URL" | "HASH"; key: string; label?: string } | null;
  port: number | null;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function parseThreatFoxTimestamp(value: string): string {
  const parsed = threatFoxTimestampSchema.safeParse(value);
  if (!parsed.success) {
    throw new CollectionFailure("SCHEMA_ERROR", "ThreatFox timestamp is outside the documented UTC format", false);
  }
  const normalized = `${value.slice(0, 10)}T${value.slice(11, 19)}.000Z`;
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    throw new CollectionFailure("SCHEMA_ERROR", "ThreatFox timestamp is not a valid UTC instant", false);
  }
  return normalized;
}

export function threatFoxRecoveryWindow(
  nowMs: number,
  lastSuccessfulCollectionAt: string | null,
): { days: number; recoveryGapExceeded: boolean } {
  if (lastSuccessfulCollectionAt === null) return { days: 7, recoveryGapExceeded: false };
  const priorMs = Date.parse(lastSuccessfulCollectionAt);
  if (!Number.isFinite(priorMs)) {
    throw new CollectionFailure("SCHEMA_ERROR", "ThreatFox checkpoint contains an invalid collection timestamp", false);
  }
  const gapMs = Math.max(0, nowMs - priorMs);
  return {
    days: Math.min(7, Math.max(1, Math.ceil(gapMs / DAY_MS))),
    recoveryGapExceeded: gapMs > 7 * DAY_MS,
  };
}

function normalizeDomain(value: string): string | null {
  const candidate = value.trim().replace(/\.$/, "");
  if (!candidate || candidate.length > 253) return null;
  const ascii = domainToASCII(candidate.toLowerCase());
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return null;
  }
  return ascii;
}

function normalizeIpPort(value: string): { ip: string; port: number } | null {
  const candidate = value.trim();
  let host: string;
  let portSource: string;
  if (candidate.startsWith("[")) {
    const match = /^\[([^\]]+)\]:(\d{1,5})$/.exec(candidate);
    if (!match) return null;
    host = match[1] ?? "";
    portSource = match[2] ?? "";
  } else {
    const separator = candidate.lastIndexOf(":");
    if (separator <= 0) return null;
    host = candidate.slice(0, separator);
    portSource = candidate.slice(separator + 1);
  }
  if (!isIP(host)) return null;
  const port = Number(portSource);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { ip: host.toLowerCase(), port };
}

function normalizeUrl(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function normalizeHash(value: string, algorithm: "md5" | "sha1" | "sha256"): string | null {
  const lengths = { md5: 32, sha1: 40, sha256: 64 } as const;
  const normalized = value.trim().toLowerCase();
  if (normalized.length !== lengths[algorithm] || !/^[0-9a-f]+$/.test(normalized)) return null;
  return `${algorithm}:${normalized}`;
}

export function normalizeThreatFoxIndicator(iocType: string, value: string): IndicatorNormalization {
  if (iocType === "domain") {
    const normalized = normalizeDomain(value);
    return normalized === null
      ? { status: "INVALID_SOURCE_VALUE", entity: null, port: null }
      : { status: "NORMALIZED", entity: { kind: "DOMAIN", key: normalized, label: normalized }, port: null };
  }
  if (iocType === "url") {
    const normalized = normalizeUrl(value);
    return normalized === null
      ? { status: "INVALID_SOURCE_VALUE", entity: null, port: null }
      : { status: "NORMALIZED", entity: { kind: "URL", key: normalized, label: value }, port: null };
  }
  if (iocType === "ip:port") {
    const normalized = normalizeIpPort(value);
    return normalized === null
      ? { status: "INVALID_SOURCE_VALUE", entity: null, port: null }
      : { status: "NORMALIZED", entity: { kind: "IP", key: normalized.ip, label: normalized.ip }, port: normalized.port };
  }
  if (iocType === "md5_hash" || iocType === "sha1_hash" || iocType === "sha256_hash") {
    const algorithm = iocType === "md5_hash" ? "md5" : iocType === "sha1_hash" ? "sha1" : "sha256";
    const normalized = normalizeHash(value, algorithm);
    return normalized === null
      ? { status: "INVALID_SOURCE_VALUE", entity: null, port: null }
      : { status: "NORMALIZED", entity: { kind: "HASH", key: normalized, label: value.toLowerCase() }, port: null };
  }
  return { status: "UNMAPPED", entity: null, port: null };
}

function safeHttpReference(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function snapshotFingerprint(records: readonly ThreatFoxIoc[]): string {
  const fingerprints = records.map((record) => ({
    id: record.id,
    fingerprint: sha256(canonicalJsonStringify(record)),
  }));
  fingerprints.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return sha256(fingerprints.map((entry) => `${entry.id}:${entry.fingerprint}\n`).join(""));
}

function classifyQueryStatus(status: string): CollectionFailure {
  const safeStatus = status.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 128) || "unknown";
  if (safeStatus.toLowerCase().includes("auth")) {
    return new CollectionFailure("AUTHENTICATION_ERROR", `ThreatFox rejected authentication with query status ${safeStatus}`, false);
  }
  if (safeStatus.toLowerCase().includes("rate")) {
    return new CollectionFailure("RATE_LIMITED", `ThreatFox reported rate limiting with query status ${safeStatus}`, true);
  }
  return new CollectionFailure("PROVIDER_ERROR", `ThreatFox returned query status ${safeStatus}`, false);
}

function manifestFromResponse(input: {
  work: ThreatFoxWorkDescriptor;
  recordCount: number;
  responseBytes: number;
  responseSha256: string;
  snapshotFingerprint: string;
  minFirstSeen: string | null;
  maxFirstSeen: string | null;
}): ThreatFoxManifest {
  return manifestPayloadSchema.parse({
    kind: "THREATFOX_QUERY_MANIFEST",
    query: "get_iocs",
    days: input.work.days,
    queryStatus: "ok",
    recordCount: input.recordCount,
    responseBytes: input.responseBytes,
    responseSha256: input.responseSha256,
    snapshotFingerprint: input.snapshotFingerprint,
    minFirstSeen: input.minFirstSeen,
    maxFirstSeen: input.maxFirstSeen,
    recoveryGapExceeded: input.work.recoveryGapExceeded,
  });
}

export function normalizeThreatFoxPayload(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "THREATFOX_QUERY_MANIFEST") return [];

  const source = payload.source;
  const firstSeen = parseThreatFoxTimestamp(source.first_seen);
  const lastSeen = source.last_seen === null ? null : parseThreatFoxTimestamp(source.last_seen);
  const indicator = normalizeThreatFoxIndicator(source.ioc_type, source.ioc);
  const entities: CanonicalEvidenceDraft["entities"] = [];
  if (indicator.entity !== null) entities.push(indicator.entity);

  const malware = source.malware?.trim();
  if (malware) {
    const label = source.malware_printable?.trim() || malware;
    entities.push({ kind: "MALWARE", key: `malpedia:${malware.toLowerCase()}`, label });
  }

  const facts: CanonicalEvidenceDraft["facts"] = [
    { predicate: "threatfox.source_ioc_id", value: source.id },
    { predicate: "threatfox.ioc_value_raw", value: source.ioc },
    { predicate: "threatfox.ioc_type", value: source.ioc_type },
    { predicate: "threatfox.threat_type", value: source.threat_type },
    { predicate: "threatfox.confidence_level", value: source.confidence_level },
    { predicate: "threatfox.first_seen", value: firstSeen },
    { predicate: "threatfox.last_seen", value: lastSeen },
    { predicate: "baykush.indicator_normalization_status", value: indicator.status },
  ];
  if (source.ioc_type_desc !== undefined && source.ioc_type_desc !== null) {
    facts.push({ predicate: "threatfox.ioc_type_description", value: source.ioc_type_desc });
  }
  if (source.threat_type_desc !== undefined && source.threat_type_desc !== null) {
    facts.push({ predicate: "threatfox.threat_type_description", value: source.threat_type_desc });
  }
  if (source.reporter !== undefined && source.reporter !== null) {
    facts.push({ predicate: "threatfox.reporter", value: source.reporter });
  }
  if (source.reference !== undefined && source.reference !== null) {
    facts.push({ predicate: "threatfox.reference", value: source.reference });
  }
  if (source.tags !== undefined && source.tags !== null) {
    facts.push({ predicate: "threatfox.tags", value: source.tags });
  }
  if (source.malware !== undefined && source.malware !== null) {
    facts.push({ predicate: "threatfox.malware", value: source.malware });
  }
  if (source.malware_printable !== undefined && source.malware_printable !== null) {
    facts.push({ predicate: "threatfox.malware_printable", value: source.malware_printable });
  }
  if (source.malware_alias !== undefined && source.malware_alias !== null) {
    facts.push({ predicate: "threatfox.malware_alias", value: source.malware_alias });
  }
  if (source.malware_malpedia !== undefined && source.malware_malpedia !== null) {
    facts.push({ predicate: "threatfox.malpedia_reference", value: source.malware_malpedia });
  }
  if (source.is_compromised !== undefined && source.is_compromised !== null) {
    facts.push({ predicate: "threatfox.is_compromised", value: source.is_compromised === true || source.is_compromised === 1 || source.is_compromised === "1" });
  }
  if (indicator.port !== null) facts.push({ predicate: "threatfox.port", value: indicator.port });

  const references = new Set<string>([`https://threatfox.abuse.ch/ioc/${source.id}/`]);
  const externalReference = safeHttpReference(source.reference);
  if (externalReference) references.add(externalReference);
  const malpediaReference = safeHttpReference(source.malware_malpedia);
  if (malpediaReference) references.add(malpediaReference);

  return [{
    recordKind: "IOC_REPORT",
    canonicalKey: `threatfox:ioc:${source.id}`,
    entities,
    facts,
    references: [...references],
  }];
}

export function createThreatFoxAdapter(options: ThreatFoxAdapterOptions = {}): SourceAdapter {
  const authKey = options.authKey ?? config.threatFoxAuthKey;
  const fetchImpl = options.fetchImpl;
  const now = options.now ?? Date.now;
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;

  return {
    definition: {
      sourceKey: "THREATFOX",
      displayName: "ThreatFox Recent IOC Reports",
      providerName: "abuse.ch ThreatFox",
      upstreamOriginKey: "ABUSE_CH_THREATFOX",
      sourceClass: "IOC_SHARING",
      observationBasis: "REPORTED",
      authorityType: "COMMUNITY_IOC_SHARING_PLATFORM",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 3_600,
      minimumPollIntervalSeconds: 3_600,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "SNAPSHOT_RECONSTRUCTION",
      historicalMaxWindowSeconds: null,
      requiresAuth: true,
      authRequirement: "REQUIRED",
      credentialKind: "THREATFOX_AUTH_KEY",
      adapterVersion: "threatfox-adapter-v1",
      semanticContractVersion: "threatfox-semantics-v1",
      licenseClass: "ABUSE_CH_FAIR_USE_2025_11_04",
      commercialUseStatus: "RESTRICTED",
      redistributionStatus: "UNKNOWN",
      attributionRequirement: null,
      termsReference: "https://abuse.ch/terms-of-use/",
      semanticBoundary: {
        represents: "ThreatFox source assertions that reported indicators are associated with source-defined IOC and threat types and, where present, source-provided malware labels, confidence, tags, first-seen and last-seen metadata.",
        doesNotRepresent: "Attack events, attack or victim counts, independent corroboration, current maliciousness, current reachability, attacker identity or origin, campaign attribution, geographic attack origin, active exploitation, business risk, asset risk, remediation priority, BAYKUSH Global Priority, or a global threat level. Absence from a recent ThreatFox query does not mean that an indicator is benign or that no malicious activity occurred.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_IOCS_PER_QUERY + 1,
    maxRawRecordBytes: MAX_RAW_RECORD_BYTES,
    normalizationVersion: "threatfox-normalization-v1",
    checkpointSchemaVersion: "threatfox-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema,
    plan({ checkpoint }) {
      const parsed: ThreatFoxCheckpoint | null = checkpoint === null ? null : checkpointSchema.parse(checkpoint);
      const recovery = threatFoxRecoveryWindow(now(), parsed?.lastSuccessfulCollectionAt ?? null);
      return workDescriptorSchema.parse({
        version: 1,
        mode: "RECENT_IOCS",
        days: recovery.days,
        recoveryGapExceeded: recovery.recoveryGapExceeded,
        previousSnapshotFingerprint: parsed?.lastSnapshotFingerprint ?? null,
        previousResponseSha256: parsed?.lastResponseSha256 ?? null,
        previousRecordCount: parsed?.previousRecordCount ?? null,
        previousRecoveryWindowDays: parsed?.recoveryWindowDays ?? null,
        previousRecoveryGapExceeded: parsed?.recoveryGapExceeded ?? null,
      });
    },
    async fetch({ work, signal }) {
      const descriptor: ThreatFoxWorkDescriptor = workDescriptorSchema.parse(work);
      if (!authKey) {
        throw new CollectionFailure("AUTHENTICATION_ERROR", "ThreatFox is enabled but THREATFOX_AUTH_KEY is not configured", false);
      }
      const requestBody = canonicalJsonStringify({ query: "get_iocs", days: descriptor.days });
      const response = await fetchBoundedJson({
        url: THREATFOX_API_URL,
        allowedHost: "threatfox-api.abuse.ch",
        allowedPath: "/api/v1/",
        method: "POST",
        body: requestBody,
        maxRequestBytes: MAX_REQUEST_BYTES,
        maxBytes: maxResponseBytes,
        timeoutMs: config.sourceHttpTimeoutMs,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          "Auth-Key": authKey,
        },
        redactValues: [authKey],
        ...(fetchImpl ? { fetchImpl } : {}),
        signal,
      });
      if (response.json === null) {
        throw new CollectionFailure("PROVIDER_ERROR", "ThreatFox returned an empty response body", true);
      }
      const envelope = responseEnvelopeSchema.safeParse(response.json);
      if (!envelope.success) {
        throw new CollectionFailure("SCHEMA_ERROR", "ThreatFox response envelope failed validation", false);
      }
      if (envelope.data.query_status !== "ok") throw classifyQueryStatus(envelope.data.query_status);
      if (!Array.isArray(envelope.data.data)) {
        throw new CollectionFailure("SCHEMA_ERROR", "ThreatFox successful response did not contain an IOC array", false);
      }
      if (envelope.data.data.length > MAX_IOCS_PER_QUERY) {
        throw new CollectionFailure(
          "PAYLOAD_LIMIT_EXCEEDED",
          `ThreatFox returned ${envelope.data.data.length} IOCs; bounded recent-query limit is ${MAX_IOCS_PER_QUERY}`,
          false,
        );
      }

      const records: ThreatFoxIoc[] = [];
      const seenIds = new Set<string>();
      let minFirstSeen: string | null = null;
      let maxFirstSeen: string | null = null;
      for (const candidate of envelope.data.data) {
        const parsed = threatFoxIocSchema.safeParse(candidate);
        if (!parsed.success) {
          throw new CollectionFailure("SCHEMA_ERROR", "ThreatFox IOC record failed core schema validation", false);
        }
        if (seenIds.has(parsed.data.id)) {
          throw new CollectionFailure("SOURCE_SNAPSHOT_CHANGED", `ThreatFox response contains duplicate IOC id ${parsed.data.id}`, true);
        }
        seenIds.add(parsed.data.id);
        const firstSeen = parseThreatFoxTimestamp(parsed.data.first_seen);
        if (parsed.data.last_seen !== null) parseThreatFoxTimestamp(parsed.data.last_seen);
        minFirstSeen = minFirstSeen === null || firstSeen < minFirstSeen ? firstSeen : minFirstSeen;
        maxFirstSeen = maxFirstSeen === null || firstSeen > maxFirstSeen ? firstSeen : maxFirstSeen;
        records.push(parsed.data);
      }

      const responseSha256 = sha256(response.bytes);
      const fingerprint = snapshotFingerprint(records);
      const nowIso = new Date(now()).toISOString();
      const nextCheckpoint = checkpointSchema.parse({
        version: 1,
        lastSuccessfulCollectionAt: nowIso,
        lastSnapshotFingerprint: fingerprint,
        lastResponseSha256: responseSha256,
        previousRecordCount: records.length,
        maxFirstSeen,
        recoveryWindowDays: descriptor.days,
        recoveryGapExceeded: descriptor.recoveryGapExceeded,
      });

      if (
        descriptor.previousSnapshotFingerprint === fingerprint &&
        descriptor.previousResponseSha256 === responseSha256 &&
        descriptor.previousRecordCount === records.length &&
        descriptor.previousRecoveryWindowDays === descriptor.days &&
        descriptor.previousRecoveryGapExceeded === descriptor.recoveryGapExceeded
      ) {
        return { records: [], nextWork: null, nextCheckpoint, complete: true };
      }

      const manifest = manifestFromResponse({
        work: descriptor,
        recordCount: records.length,
        responseBytes: response.bytes.length,
        responseSha256,
        snapshotFingerprint: fingerprint,
        minFirstSeen,
        maxFirstSeen,
      });
      const fetched: ThreatFoxFetchedRecord[] = [{
        kind: "QUERY_MANIFEST",
        payload: manifest,
      }];
      for (const record of records) {
        fetched.push({
          kind: "IOC",
          payload: iocPayloadSchema.parse({ kind: "THREATFOX_IOC", source: record }),
        });
      }
      return { records: fetched, nextWork: null, nextCheckpoint, complete: true };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record).payload;
      return parsed.kind === "THREATFOX_QUERY_MANIFEST" ? "query-manifest" : parsed.source.id;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record).payload;
      if (parsed.kind === "THREATFOX_QUERY_MANIFEST") {
        return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
      }
      return {
        publishedAt: null,
        effectiveAt: parseThreatFoxTimestamp(parsed.source.first_seen),
        upstreamUpdatedAt: null,
      };
    },
    sourceReference() {
      return THREATFOX_API_URL.toString();
    },
    sourceSchemaVersion(record) {
      const parsed = fetchedRecordSchema.parse(record).payload;
      return parsed.kind === "THREATFOX_QUERY_MANIFEST" ? SOURCE_SCHEMA_MANIFEST : SOURCE_SCHEMA_IOC;
    },
    rawPayload(record) {
      return fetchedRecordSchema.parse(record).payload;
    },
    normalize(record) {
      return normalizeThreatFoxPayload(record);
    },
    classifyFailure(error) {
      if (error instanceof z.ZodError) {
        return { code: "SCHEMA_ERROR", retryable: false, message: "ThreatFox data failed validation" };
      }
      return classifyUnknownFailure(error);
    },
  };
}

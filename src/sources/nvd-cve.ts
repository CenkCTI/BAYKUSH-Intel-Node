import { z } from "zod";
import { config } from "../config.js";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";

const NVD_DEFAULT_PAGE_SIZE = 2_000;
const NVD_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const NVD_MAX_RAW_RECORD_BYTES = 4 * 1024 * 1024;
const NVD_PAGE_MIN_INTERVAL_MS = 6_500;
const NVD_BOOTSTRAP_WINDOW_MS = 24 * 60 * 60 * 1_000;
const NVD_RECOVERY_SEGMENT_MS = 24 * 60 * 60 * 1_000;
const NVD_LIVE_OVERLAP_MS = 5 * 60 * 1_000;
const NVD_PROVIDER_MAX_WINDOW_MS = 120 * 24 * 60 * 60 * 1_000;
const NVD_PROVIDER_MAX_WINDOW_SECONDS = 120 * 24 * 60 * 60;
const NVD_MAX_WINDOW_RESTARTS = 3;
const SOURCE_SCHEMA_VERSION = "nvd-cve-api-2.0";
const USER_AGENT = "BAYKUSH-Intelligence-Node/0.2 (+https://github.com/CenkCTI/BAYKUSH-Intel-Node)";

export const NVD_CVE_API_URL = new URL("https://services.nvd.nist.gov/rest/json/cves/2.0/");
export const NVD_CVE_DETAIL_BASE_URL = "https://nvd.nist.gov/vuln/detail/";

const cveIdSchema = z.string().regex(/^CVE-[0-9]{4}-[0-9]{4,19}$/);
const internalDateTimeSchema = z.string().datetime({ offset: true });

function sourceTimestampMilliseconds(value: string): number {
  const withZone = /(Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value) ? value : `${value}Z`;
  return Date.parse(withZone);
}

function normalizeNvdSourceTimestamp(value: string, label: string): string {
  const milliseconds = sourceTimestampMilliseconds(value);
  if (!Number.isFinite(milliseconds)) {
    throw new CollectionFailure("SCHEMA_ERROR", `NVD ${label} is not a valid datetime`, false);
  }
  return new Date(milliseconds).toISOString();
}

// NVD API examples and schemas use UTC timestamps that may omit an explicit Z/offset.
// Preserve the source string in raw JSON, but normalize timestamps before PostgreSQL persistence.
const nvdSourceDateTimeSchema = z.string().min(1).max(64).refine(
  (value) => Number.isFinite(sourceTimestampMilliseconds(value)),
  "invalid NVD source datetime",
);

const descriptionSchema = z.object({
  lang: z.string().min(1).max(32),
  value: z.string().max(256_000),
}).passthrough();

export const nvdCveSchema = z.object({
  id: cveIdSchema,
  sourceIdentifier: z.string().min(1).max(2_048),
  published: nvdSourceDateTimeSchema,
  lastModified: nvdSourceDateTimeSchema,
  vulnStatus: z.string().min(1).max(128),
  descriptions: z.array(descriptionSchema).max(512).optional(),
  metrics: z.unknown().optional(),
  weaknesses: z.unknown().optional(),
  configurations: z.unknown().optional(),
  references: z.unknown().optional(),
  cveTags: z.unknown().optional(),
  vendorComments: z.unknown().optional(),
}).passthrough();
export type NvdCve = z.infer<typeof nvdCveSchema>;

const vulnerabilityWrapperSchema = z.object({ cve: nvdCveSchema }).passthrough();
export const nvdCveResponseSchema = z.object({
  resultsPerPage: z.number().int().nonnegative().max(NVD_DEFAULT_PAGE_SIZE),
  startIndex: z.number().int().nonnegative(),
  totalResults: z.number().int().nonnegative(),
  format: z.string().max(128).optional(),
  version: z.string().max(128).optional(),
  timestamp: nvdSourceDateTimeSchema.optional(),
  vulnerabilities: z.array(vulnerabilityWrapperSchema).max(NVD_DEFAULT_PAGE_SIZE),
}).passthrough();

const activeWindowSchema = z.object({
  windowStart: internalDateTimeSchema,
  windowEnd: internalDateTimeSchema,
  targetEnd: internalDateTimeSchema,
  startIndex: z.number().int().nonnegative(),
  expectedTotalResults: z.number().int().nonnegative().nullable(),
  restartCount: z.number().int().nonnegative().max(NVD_MAX_WINDOW_RESTARTS),
}).strict();
type ActiveWindow = z.infer<typeof activeWindowSchema>;

const checkpointSchema = z.object({
  version: z.literal(1),
  completedThrough: internalDateTimeSchema.nullable(),
  activeWindow: activeWindowSchema.nullable(),
}).strict();
type NvdCheckpoint = z.infer<typeof checkpointSchema>;

const workDescriptorSchema = activeWindowSchema.extend({
  completedThroughBeforeWindow: internalDateTimeSchema.nullable(),
  notBeforeRequestAt: internalDateTimeSchema.nullable(),
}).strict();
type NvdWorkDescriptor = z.infer<typeof workDescriptorSchema>;

const fetchedRecordSchema = z.object({
  kind: z.literal("CVE"),
  payload: nvdCveSchema,
  responseVersion: z.string().min(1).max(128),
}).strict();

interface NvdAdapterOptions {
  fetchImpl?: typeof fetch;
  apiKey?: string;
  pageSize?: number;
  baseUrl?: URL;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function iso(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function parseTime(value: string, label: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new CollectionFailure("SCHEMA_ERROR", `NVD ${label} is not a valid datetime`, false);
  }
  return milliseconds;
}

function assertWindow(window: Pick<ActiveWindow, "windowStart" | "windowEnd" | "targetEnd">): void {
  const start = parseTime(window.windowStart, "windowStart");
  const end = parseTime(window.windowEnd, "windowEnd");
  const target = parseTime(window.targetEnd, "targetEnd");
  if (end < start) throw new CollectionFailure("SCHEMA_ERROR", "NVD windowEnd precedes windowStart", false);
  if (target < end) throw new CollectionFailure("SCHEMA_ERROR", "NVD targetEnd precedes windowEnd", false);
  if (end - start > NVD_PROVIDER_MAX_WINDOW_MS) {
    throw new CollectionFailure("SCHEMA_ERROR", "NVD query window exceeds provider maximum", false);
  }
}

function activeToWork(
  activeWindow: ActiveWindow,
  completedThroughBeforeWindow: string | null,
  notBeforeRequestAt: string | null,
): NvdWorkDescriptor {
  return workDescriptorSchema.parse({
    ...activeWindow,
    completedThroughBeforeWindow,
    notBeforeRequestAt,
  });
}

function initialActiveWindow(checkpoint: NvdCheckpoint | null, nowMs: number): {
  activeWindow: ActiveWindow;
  completedThroughBeforeWindow: string | null;
} {
  if (checkpoint?.activeWindow) {
    assertWindow(checkpoint.activeWindow);
    return {
      activeWindow: checkpoint.activeWindow,
      completedThroughBeforeWindow: checkpoint.completedThrough,
    };
  }

  if (!checkpoint?.completedThrough) {
    const targetEnd = nowMs;
    const activeWindow = activeWindowSchema.parse({
      windowStart: iso(targetEnd - NVD_BOOTSTRAP_WINDOW_MS),
      windowEnd: iso(targetEnd),
      targetEnd: iso(targetEnd),
      startIndex: 0,
      expectedTotalResults: null,
      restartCount: 0,
    });
    assertWindow(activeWindow);
    return { activeWindow, completedThroughBeforeWindow: null };
  }

  const completedMs = parseTime(checkpoint.completedThrough, "completedThrough");
  const targetEnd = Math.max(nowMs, completedMs);
  const segmentEnd = Math.min(completedMs + NVD_RECOVERY_SEGMENT_MS, targetEnd);
  const activeWindow = activeWindowSchema.parse({
    windowStart: iso(completedMs - NVD_LIVE_OVERLAP_MS),
    windowEnd: iso(segmentEnd),
    targetEnd: iso(targetEnd),
    startIndex: 0,
    expectedTotalResults: null,
    restartCount: 0,
  });
  assertWindow(activeWindow);
  return { activeWindow, completedThroughBeforeWindow: checkpoint.completedThrough };
}

function nextSegment(completedThrough: string, targetEnd: string): ActiveWindow | null {
  const completedMs = parseTime(completedThrough, "completedThrough");
  const targetMs = parseTime(targetEnd, "targetEnd");
  if (completedMs >= targetMs) return null;
  const segmentEnd = Math.min(completedMs + NVD_RECOVERY_SEGMENT_MS, targetMs);
  const activeWindow = activeWindowSchema.parse({
    windowStart: iso(completedMs - NVD_LIVE_OVERLAP_MS),
    windowEnd: iso(segmentEnd),
    targetEnd,
    startIndex: 0,
    expectedTotalResults: null,
    restartCount: 0,
  });
  assertWindow(activeWindow);
  return activeWindow;
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  if (signal.aborted) throw new DOMException("NVD pacing wait aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("NVD pacing wait aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function honorPacing(
  notBeforeRequestAt: string | null,
  now: () => number,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!notBeforeRequestAt) return;
  const delay = parseTime(notBeforeRequestAt, "notBeforeRequestAt") - now();
  if (delay > 0) await sleep(delay, signal);
}

function buildRequestUrl(baseUrl: URL, work: NvdWorkDescriptor, pageSize: number): URL {
  assertWindow(work);
  const url = new URL(baseUrl.toString());
  url.searchParams.set("lastModStartDate", work.windowStart);
  url.searchParams.set("lastModEndDate", work.windowEnd);
  url.searchParams.set("resultsPerPage", String(pageSize));
  url.searchParams.set("startIndex", String(work.startIndex));
  return url;
}

function safeReferenceUrls(cve: NvdCve): string[] {
  const output = [`${NVD_CVE_DETAIL_BASE_URL}${encodeURIComponent(cve.id)}`];
  const seen = new Set(output);
  if (!Array.isArray(cve.references)) return output;
  for (const reference of cve.references) {
    if (!reference || typeof reference !== "object") continue;
    const candidate = (reference as Record<string, unknown>).url;
    if (typeof candidate !== "string" || candidate.length > 2_048) continue;
    try {
      const parsed = new URL(candidate);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      const normalized = parsed.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        output.push(normalized);
      }
    } catch {
      // Invalid source-native references remain preserved in immutable raw JSON.
    }
    if (output.length >= 64) break;
  }
  return output;
}

function configurationCounts(value: unknown): { nodeCount: number; cpeMatchCount: number } {
  let nodeCount = 0;
  let cpeMatchCount = 0;
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (Array.isArray(object.nodes)) {
      nodeCount += object.nodes.length;
      for (const node of object.nodes) visit(node);
    }
    if (Array.isArray(object.children)) {
      nodeCount += object.children.length;
      for (const child of object.children) visit(child);
    }
    if (Array.isArray(object.cpeMatch)) cpeMatchCount += object.cpeMatch.length;
  };
  visit(value);
  return { nodeCount, cpeMatchCount };
}

export function normalizeNvdCve(input: unknown): CanonicalEvidenceDraft {
  const cve = nvdCveSchema.parse(input);
  const facts: CanonicalEvidenceDraft["facts"] = [
    { predicate: "nvd.cve_id", value: cve.id },
    { predicate: "nvd.source_identifier", value: cve.sourceIdentifier },
    { predicate: "nvd.vuln_status", value: cve.vulnStatus },
  ];
  if (cve.descriptions !== undefined) facts.push({ predicate: "nvd.descriptions", value: cve.descriptions });
  if (cve.metrics !== undefined) facts.push({ predicate: "nvd.cvss_metrics", value: cve.metrics });
  if (cve.weaknesses !== undefined) facts.push({ predicate: "nvd.weaknesses", value: cve.weaknesses });
  if (cve.cveTags !== undefined) facts.push({ predicate: "nvd.cve_tags", value: cve.cveTags });
  if (cve.vendorComments !== undefined) facts.push({ predicate: "nvd.vendor_comments", value: cve.vendorComments });
  const configurations = configurationCounts(cve.configurations);
  facts.push({ predicate: "nvd.reference_count", value: Array.isArray(cve.references) ? cve.references.length : 0 });
  facts.push({ predicate: "nvd.configuration_present", value: cve.configurations !== undefined });
  facts.push({ predicate: "nvd.configuration_node_count", value: configurations.nodeCount });
  facts.push({ predicate: "nvd.cpe_match_count", value: configurations.cpeMatchCount });

  return {
    recordKind: "VULNERABILITY_RECORD",
    canonicalKey: `cve:${cve.id}`,
    entities: [{ kind: "CVE", key: cve.id, label: cve.id }],
    facts,
    references: safeReferenceUrls(cve),
  };
}

export function createNvdCveAdapter(options: NvdAdapterOptions = {}): SourceAdapter {
  const pageSize = options.pageSize ?? NVD_DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > NVD_DEFAULT_PAGE_SIZE) {
    throw new Error("NVD pageSize must be an integer between 1 and 2000");
  }
  const baseUrl = options.baseUrl ?? NVD_CVE_API_URL;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const apiKey = options.apiKey?.trim() || undefined;

  return {
    definition: {
      sourceKey: "NVD_CVE",
      displayName: "NVD CVE API 2.0",
      providerName: "National Vulnerability Database (NIST)",
      upstreamOriginKey: "NVD_CVE",
      sourceClass: "VULNERABILITY_DATABASE",
      observationBasis: "ENRICHED",
      authorityType: "GOVERNMENT_DATABASE",
      collectionMode: "PAGED_POLL",
      defaultPollIntervalSeconds: 7_200,
      minimumPollIntervalSeconds: 7_200,
      supportsHistoricalRetrieval: true,
      recoveryStrategy: "HISTORICAL_QUERY",
      historicalMaxWindowSeconds: NVD_PROVIDER_MAX_WINDOW_SECONDS,
      requiresAuth: false,
      authRequirement: "OPTIONAL",
      credentialKind: "NVD_API_KEY",
      adapterVersion: "nvd-cve-adapter-v1",
      semanticContractVersion: "nvd-cve-semantics-v1",
      licenseClass: "US-PUBLIC-DOMAIN-NVD-TOU",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "Applications using the NVD API should state that the product uses NVD API data but is not endorsed or certified by the NVD. Modified BAYKUSH projections must not be represented as NVD-authored content.",
      termsReference: "https://nvd.nist.gov/developers/terms-of-use",
      semanticBoundary: {
        represents: "CVE records as published through NVD, including NVD/CVE-source enrichment state, descriptions, scoring metadata, weaknesses, references, and applicability information.",
        doesNotRepresent: "Direct exploit observations, attack or victim counts, exploit probability, business risk, remediation priority, active exploitation proof, or independent corroboration of CISA-derived fields mirrored by NVD.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: pageSize,
    maxRawRecordBytes: NVD_MAX_RAW_RECORD_BYTES,
    normalizationVersion: "nvd-cve-normalization-v1",
    checkpointSchemaVersion: "nvd-cve-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema,
    plan({ checkpoint }) {
      const parsedCheckpoint = checkpoint === null ? null : checkpointSchema.parse(checkpoint);
      const planned = initialActiveWindow(parsedCheckpoint, now());
      return activeToWork(planned.activeWindow, planned.completedThroughBeforeWindow, null);
    },
    async fetch({ work, signal }) {
      const descriptor = workDescriptorSchema.parse(work);
      await honorPacing(descriptor.notBeforeRequestAt, now, sleep, signal);
      const requestUrl = buildRequestUrl(baseUrl, descriptor, pageSize);
      const headers: Record<string, string> = {
        accept: "application/json",
        "user-agent": USER_AGENT,
      };
      if (apiKey) headers.apiKey = apiKey;
      const response = await fetchBoundedJson({
        url: requestUrl,
        allowedHost: baseUrl.hostname,
        allowedPath: baseUrl.pathname,
        maxBytes: NVD_MAX_RESPONSE_BYTES,
        timeoutMs: config.sourceHttpTimeoutMs,
        headers,
        ...(apiKey ? { redactValues: [apiKey] } : {}),
        signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (response.json === null) {
        throw new CollectionFailure("PROVIDER_ERROR", "NVD CVE API returned an empty success response", true);
      }

      let parsed;
      try {
        parsed = nvdCveResponseSchema.parse(response.json);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new CollectionFailure("SCHEMA_ERROR", "NVD CVE response failed its core API contract", false, { cause: error });
        }
        throw error;
      }
      if (parsed.startIndex !== descriptor.startIndex) {
        throw new CollectionFailure("SCHEMA_ERROR", "NVD response startIndex does not match the requested page", false);
      }
      if (parsed.resultsPerPage > pageSize) {
        throw new CollectionFailure("SCHEMA_ERROR", "NVD response exceeded the requested page size", false);
      }
      if (parsed.totalResults > 0 && parsed.resultsPerPage === 0) {
        throw new CollectionFailure("SCHEMA_ERROR", "NVD returned zero page capacity for a non-empty result set", false);
      }
      if (parsed.totalResults > 0 && parsed.startIndex >= parsed.totalResults) {
        throw new CollectionFailure("SCHEMA_ERROR", "NVD returned a page starting beyond totalResults", false);
      }
      const remaining = Math.max(0, parsed.totalResults - parsed.startIndex);
      const expectedPageRecords = Math.min(parsed.resultsPerPage, remaining);
      if (parsed.vulnerabilities.length !== expectedPageRecords) {
        throw new CollectionFailure("SCHEMA_ERROR", "NVD page record count is inconsistent with pagination metadata", false);
      }
      const ids = parsed.vulnerabilities.map((item) => item.cve.id);
      if (new Set(ids).size !== ids.length) {
        throw new CollectionFailure("SCHEMA_ERROR", "NVD page contains duplicate CVE identifiers", false);
      }

      if (descriptor.expectedTotalResults !== null && descriptor.expectedTotalResults !== parsed.totalResults) {
        if (descriptor.restartCount >= NVD_MAX_WINDOW_RESTARTS) {
          throw new CollectionFailure("SOURCE_SNAPSHOT_CHANGED", "NVD result population changed repeatedly during a fixed pagination window", true);
        }
        const resetWindow = activeWindowSchema.parse({
          windowStart: descriptor.windowStart,
          windowEnd: descriptor.windowEnd,
          targetEnd: descriptor.targetEnd,
          startIndex: 0,
          expectedTotalResults: null,
          restartCount: descriptor.restartCount + 1,
        });
        const notBeforeRequestAt = iso(now() + NVD_PAGE_MIN_INTERVAL_MS);
        return {
          records: [],
          nextWork: activeToWork(resetWindow, descriptor.completedThroughBeforeWindow, notBeforeRequestAt),
          nextCheckpoint: {
            version: 1,
            completedThrough: descriptor.completedThroughBeforeWindow,
            activeWindow: resetWindow,
          },
          complete: false,
        };
      }

      const stableTotal = descriptor.expectedTotalResults ?? parsed.totalResults;
      const records = parsed.vulnerabilities.map((item) => ({
        kind: "CVE" as const,
        payload: item.cve,
        responseVersion: parsed.version ?? SOURCE_SCHEMA_VERSION,
      }));
      const nextIndex = parsed.startIndex + parsed.resultsPerPage;
      const hasMorePages = nextIndex < stableTotal;
      const notBeforeRequestAt = iso(now() + NVD_PAGE_MIN_INTERVAL_MS);

      if (hasMorePages) {
        const nextActive = activeWindowSchema.parse({
          windowStart: descriptor.windowStart,
          windowEnd: descriptor.windowEnd,
          targetEnd: descriptor.targetEnd,
          startIndex: nextIndex,
          expectedTotalResults: stableTotal,
          restartCount: descriptor.restartCount,
        });
        return {
          records,
          nextWork: activeToWork(nextActive, descriptor.completedThroughBeforeWindow, notBeforeRequestAt),
          nextCheckpoint: {
            version: 1,
            completedThrough: descriptor.completedThroughBeforeWindow,
            activeWindow: nextActive,
          },
          complete: false,
        };
      }

      const completedThrough = descriptor.windowEnd;
      const recoveryNext = nextSegment(completedThrough, descriptor.targetEnd);
      if (recoveryNext) {
        return {
          records,
          nextWork: activeToWork(recoveryNext, completedThrough, notBeforeRequestAt),
          nextCheckpoint: {
            version: 1,
            completedThrough,
            activeWindow: recoveryNext,
          },
          complete: false,
        };
      }

      return {
        records,
        nextWork: null,
        nextCheckpoint: {
          version: 1,
          completedThrough,
          activeWindow: null,
        },
        complete: true,
      };
    },
    identifyRawRecord(record) {
      return fetchedRecordSchema.parse(record).payload.id;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record).payload;
      return {
        publishedAt: normalizeNvdSourceTimestamp(parsed.published, "published"),
        effectiveAt: null,
        upstreamUpdatedAt: normalizeNvdSourceTimestamp(parsed.lastModified, "lastModified"),
      };
    },
    sourceReference(record) {
      const id = fetchedRecordSchema.parse(record).payload.id;
      return `${NVD_CVE_DETAIL_BASE_URL}${encodeURIComponent(id)}`;
    },
    sourceSchemaVersion(record) {
      return fetchedRecordSchema.parse(record).responseVersion;
    },
    rawPayload(record) {
      return fetchedRecordSchema.parse(record).payload;
    },
    normalize(record) {
      return [normalizeNvdCve(record)];
    },
    classifyFailure(error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { code: "TIMEOUT", retryable: true, message: "NVD collection pacing or request was cancelled" };
      }
      if (error instanceof z.ZodError) {
        return { code: "SCHEMA_ERROR", retryable: false, message: "NVD data failed validation" };
      }
      return classifyUnknownFailure(error);
    },
  };
}

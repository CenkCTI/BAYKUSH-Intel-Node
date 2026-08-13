import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";

const endpoint = new URL("https://api.github.com/advisories");
const pageSize = 100;
const schema = z.object({
  ghsa_id: z.string().min(1).max(64),
  cve_id: z.string().nullable(),
  html_url: z.string().url(),
  summary: z.string().min(1).max(4096),
  type: z.literal("reviewed"),
  severity: z.string().min(1).max(32),
  published_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
  identifiers: z.array(z.object({ type: z.string(), value: z.string() }).passthrough()).max(100),
  references: z.array(z.string().url()).max(500),
  vulnerabilities: z.array(z.object({
    package: z.object({ ecosystem: z.string().min(1).max(64), name: z.string().min(1).max(512) }).passthrough(),
    first_patched_version: z.unknown().nullable().optional(),
    vulnerable_version_range: z.string().max(4096).nullable().optional(),
  }).passthrough()).max(2000),
}).passthrough();
const responseSchema = z.array(schema).max(pageSize);
const recordSchema = z.object({ kind: z.literal("REVIEWED_ADVISORY"), source: schema }).strict();
const checkpointSchema = z.object({ version: z.literal(1), watermark: z.string().datetime({ offset: true }).nullable() }).strict();
const workSchema = z.object({
  version: z.literal(1),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
}).strict();

function requestUrl(work: z.infer<typeof workSchema>): URL {
  const url = new URL(endpoint);
  url.searchParams.set("type", "reviewed");
  url.searchParams.set("per_page", String(pageSize));
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "asc");
  url.searchParams.set("modified", `${work.start}..${work.end}`);
  return url;
}

export function createPackageAdvisoryAdapter(options: { fetchImpl?: typeof fetch; now?: () => number } = {}): SourceAdapter {
  return {
    definition: {
      sourceKey: "GITHUB_ADVISORY_REVIEWED",
      displayName: "GitHub Advisory Database — Reviewed",
      providerName: "GitHub",
      upstreamOriginKey: "GITHUB_ADVISORY_DATABASE_REVIEWED",
      sourceClass: "VULNERABILITY_DATABASE",
      observationBasis: "PUBLISHED",
      authorityType: "CURATED_ADVISORY_AGGREGATOR",
      collectionMode: "PAGED_POLL",
      defaultPollIntervalSeconds: 3600,
      minimumPollIntervalSeconds: 300,
      supportsHistoricalRetrieval: true,
      recoveryStrategy: "HISTORICAL_QUERY",
      historicalMaxWindowSeconds: 604800,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "github-reviewed-advisory-adapter-v1",
      semanticContractVersion: "github-reviewed-advisory-semantics-v1",
      licenseClass: "CC-BY-4.0",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "Retain GitHub Advisory Database and CC-BY-4.0 attribution for redistributed licensed material.",
      termsReference: "https://github.com/github/advisory-database/blob/main/LICENSE.md",
      semanticBoundary: {
        represents: "GitHub-reviewed package security advisories published through the GitHub Advisory Database.",
        doesNotRepresent: "Unreviewed NVD-derived entries, malware advisories, deployment prevalence, organization exposure, business risk, or global activity levels.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: pageSize,
    maxRawRecordBytes: 512 * 1024,
    normalizationVersion: "github-reviewed-advisory-normalization-v1",
    checkpointSchemaVersion: "github-reviewed-advisory-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: workSchema,
    plan({ checkpoint }) {
      const prior = checkpoint === null ? null : checkpointSchema.parse(checkpoint).watermark;
      const now = options.now?.() ?? Date.now();
      const start = prior ? Date.parse(prior) - 300000 : now - 86400000;
      return { version: 1, start: new Date(Math.max(start, now - 604800000)).toISOString(), end: new Date(now).toISOString() };
    },
    async fetch({ work, signal }) {
      const descriptor = workSchema.parse(work);
      const response = await fetchBoundedJson({
        url: requestUrl(descriptor), allowedHost: endpoint.hostname, allowedPath: endpoint.pathname,
        maxBytes: 8 * 1024 * 1024, timeoutMs: 20000, signal,
        headers: { Accept: "application/vnd.github+json", "User-Agent": "BAYKUSH-Intelligence-Node" },
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (response.json === null) throw new CollectionFailure("PROVIDER_ERROR", "Package advisory API returned an empty body", true);
      const rows = responseSchema.parse(response.json);
      if (rows.length === pageSize) throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", "Package advisory window saturated; use a narrower recovery window", true);
      return {
        records: rows.map((source) => ({ kind: "REVIEWED_ADVISORY" as const, source })),
        nextWork: null,
        nextCheckpoint: { version: 1, watermark: descriptor.end },
        complete: true,
      };
    },
    identifyRawRecord(record) { return recordSchema.parse(record).source.ghsa_id; },
    extractTimes(record) {
      const source = recordSchema.parse(record).source;
      return { publishedAt: source.published_at, effectiveAt: source.published_at, upstreamUpdatedAt: source.updated_at };
    },
    sourceReference(record) { return recordSchema.parse(record).source.html_url; },
    sourceSchemaVersion() { return "github-global-advisory-reviewed-v1"; },
    rawPayload(record) { return recordSchema.parse(record).source; },
    normalize(record) {
      const source = recordSchema.parse(record).source;
      const facts: CanonicalEvidenceDraft["facts"] = [
        { predicate: "github_advisory.ghsa_id", value: source.ghsa_id },
        { predicate: "github_advisory.cve_id", value: source.cve_id },
        { predicate: "github_advisory.severity", value: source.severity },
        { predicate: "github_advisory.summary", value: source.summary },
        { predicate: "github_advisory.vulnerabilities", value: source.vulnerabilities },
      ];
      return [{
        recordKind: "SECURITY_ADVISORY",
        canonicalKey: `security-advisory:ghsa:${source.ghsa_id.toLowerCase()}`,
        entities: source.cve_id ? [{ kind: "CVE", key: source.cve_id.toUpperCase(), label: source.cve_id.toUpperCase() }] : [],
        facts,
        references: [...new Set([source.html_url, ...source.references])].slice(0, 100),
      }];
    },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "Package advisory response failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

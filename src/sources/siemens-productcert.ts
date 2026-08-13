import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

const FEED_URL = new URL("https://cert-portal.siemens.com/productcert/csaf/ssa-feed-tlp-white.json");
const TERMS_REFERENCE = "https://www.siemens.com/productcert/terms-of-use";
const PROVIDER_METADATA_REFERENCE = "https://cert-portal.siemens.com/productcert/csaf/provider-metadata.json";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2_000;

const linkSchema = z.object({
  href: z.string().url(),
  rel: z.string().max(128).optional(),
  type: z.string().max(256).optional(),
}).passthrough();

const contentSchema = z.object({
  src: z.string().url(),
  type: z.string().max(256).optional(),
}).passthrough();

const entrySchema = z.object({
  id: z.string().min(1).max(2_048),
  title: z.string().min(1).max(8_192),
  published: z.string().datetime({ offset: true }),
  updated: z.string().datetime({ offset: true }),
  content: contentSchema,
  link: z.array(linkSchema).max(32).optional(),
  summary: z.unknown().optional(),
}).passthrough();
type SiemensFeedEntry = z.infer<typeof entrySchema>;

const feedSchema = z.object({
  feed: z.object({
    id: z.string().min(1).max(2_048),
    title: z.string().min(1).max(8_192),
    updated: z.string().datetime({ offset: true }),
    entry: z.array(entrySchema).max(MAX_ENTRIES).default([]),
  }).passthrough(),
}).passthrough();

const persistedEntrySchema = z.object({ kind: z.literal("SIEMENS_PRODUCTCERT_ENTRY"), source: entrySchema }).strict();
const manifestSchema = z.object({
  kind: z.literal("SIEMENS_PRODUCTCERT_MANIFEST"),
  feedUpdated: z.string().datetime({ offset: true }),
  itemCount: z.number().int().nonnegative().max(MAX_ENTRIES),
  responseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const persistedPayloadSchema = z.discriminatedUnion("kind", [persistedEntrySchema, manifestSchema]);
const fetchedRecordSchema = z.object({ kind: z.enum(["ENTRY", "MANIFEST"]), payload: persistedPayloadSchema }).strict();
const checkpointSchema = z.object({
  version: z.literal(1),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  responseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  feedUpdated: z.string().datetime({ offset: true }).nullable(),
  itemCount: z.number().int().nonnegative().max(MAX_ENTRIES).nullable(),
}).strict();

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function snapshotFingerprint(entries: readonly SiemensFeedEntry[]): string {
  const ordered = [...entries].sort((left, right) => left.id.localeCompare(right.id));
  return sha256(ordered.map((entry) => `${entry.id}:${sha256(canonicalJsonStringify(entry))}\n`).join(""));
}

function advisoryIdentity(entry: SiemensFeedEntry): string {
  const candidates = [entry.title, entry.id, entry.content.src];
  for (const candidate of candidates) {
    const match = candidate.match(/SSA-\d{2}-\d{3}/i);
    if (match) return match[0].toUpperCase();
  }
  return `ROLIE:${sha256(entry.id).slice(0, 24)}`;
}

function documentHashReference(entry: SiemensFeedEntry): string | null {
  return entry.link?.find((link) => link.rel?.toLowerCase() === "hash")?.href ?? null;
}

function cveIds(entry: SiemensFeedEntry): string[] {
  const haystack = `${entry.title}\n${JSON.stringify(entry.summary ?? "")}`;
  return [...new Set((haystack.match(/CVE-\d{4}-\d{4,19}/gi) ?? []).map((value) => value.toUpperCase()))].sort();
}

export function normalizeSiemensProductCertEntry(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "SIEMENS_PRODUCTCERT_MANIFEST") return [];
  const source = payload.source;
  const identity = advisoryIdentity(source);
  const cves = cveIds(source);
  return [{
    recordKind: "SECURITY_ADVISORY",
    canonicalKey: `security-advisory:siemens-productcert:${identity.toLowerCase()}`,
    entities: cves.map((cve) => ({ kind: "CVE" as const, key: cve, label: cve })),
    facts: [
      { predicate: "siemens_productcert.feed_entry_id", value: source.id },
      { predicate: "siemens_productcert.advisory_id", value: identity },
      { predicate: "siemens_productcert.title", value: source.title },
      { predicate: "siemens_productcert.published_at", value: source.published },
      { predicate: "siemens_productcert.updated_at", value: source.updated },
      { predicate: "siemens_productcert.document_url", value: source.content.src },
      { predicate: "siemens_productcert.document_type", value: source.content.type ?? null },
      { predicate: "siemens_productcert.hash_reference", value: documentHashReference(source) },
      { predicate: "siemens_productcert.cves_in_feed_entry", value: cves },
    ],
    references: [source.content.src],
  }];
}

export function createSiemensProductCertAdapter(options: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    definition: {
      sourceKey: "SIEMENS_PRODUCTCERT_CSAF",
      displayName: "Siemens ProductCERT CSAF Publications",
      providerName: "Siemens ProductCERT",
      upstreamOriginKey: "SIEMENS_PRODUCTCERT_TLP_WHITE_ROLIE",
      sourceClass: "VENDOR_PSIRT_REPORTING",
      observationBasis: "PUBLISHED",
      authorityType: "VENDOR_PSIRT",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 3_600,
      minimumPollIntervalSeconds: 900,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "SNAPSHOT_RECONSTRUCTION",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "siemens-productcert-rolie-adapter-v1",
      semanticContractVersion: "siemens-productcert-rolie-semantics-v1",
      licenseClass: "SIEMENS_PRODUCTCERT_TERMS",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "Preserve the original Siemens advisory link and identify modifications; do not use Siemens marks or advisory content in a misleading way.",
      termsReference: TERMS_REFERENCE,
      semanticBoundary: {
        represents: "TLP:WHITE security-advisory publications exposed by the Siemens ProductCERT trusted-provider CSAF ROLIE feed.",
        doesNotRepresent: "Deployment prevalence, exploitation confirmation, attack count, victim count, customer exposure, business risk, remediation priority, attribution truth, or global threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_ENTRIES,
    maxRawRecordBytes: 512 * 1024,
    normalizationVersion: "siemens-productcert-rolie-normalization-v1",
    checkpointSchemaVersion: "siemens-productcert-rolie-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) {
      return checkpoint === null
        ? { version: 1, snapshotFingerprint: null, responseSha256: null, feedUpdated: null, itemCount: null }
        : checkpointSchema.parse(checkpoint);
    },
    async fetch({ work, signal }) {
      const prior = checkpointSchema.parse(work);
      const response = await fetchBoundedJson({
        url: FEED_URL,
        allowedHost: FEED_URL.hostname,
        allowedPath: FEED_URL.pathname,
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: 20_000,
        signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (response.json === null) throw new CollectionFailure("PROVIDER_ERROR", "Siemens ProductCERT ROLIE feed returned an empty body", true);
      const feed = feedSchema.parse(response.json).feed;
      const responseSha256 = sha256(response.bytes);
      const fingerprint = snapshotFingerprint(feed.entry);
      const nextCheckpoint = { version: 1 as const, snapshotFingerprint: fingerprint, responseSha256, feedUpdated: feed.updated, itemCount: feed.entry.length };
      if (prior.snapshotFingerprint === fingerprint) {
        return { records: [], nextWork: null, nextCheckpoint, complete: true };
      }
      return {
        records: [
          ...feed.entry.map((source) => ({ kind: "ENTRY" as const, payload: { kind: "SIEMENS_PRODUCTCERT_ENTRY" as const, source } })),
          { kind: "MANIFEST" as const, payload: manifestSchema.parse({ kind: "SIEMENS_PRODUCTCERT_MANIFEST", feedUpdated: feed.updated, itemCount: feed.entry.length, responseSha256, snapshotFingerprint: fingerprint }) },
        ],
        nextWork: null,
        nextCheckpoint,
        complete: true,
      };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.payload.kind === "SIEMENS_PRODUCTCERT_MANIFEST" ? "__siemens_productcert_manifest__" : advisoryIdentity(parsed.payload.source);
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.payload.kind === "SIEMENS_PRODUCTCERT_MANIFEST") return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: parsed.payload.feedUpdated };
      return { publishedAt: parsed.payload.source.published, effectiveAt: parsed.payload.source.published, upstreamUpdatedAt: parsed.payload.source.updated };
    },
    sourceReference(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.payload.kind === "SIEMENS_PRODUCTCERT_MANIFEST" ? PROVIDER_METADATA_REFERENCE : parsed.payload.source.content.src;
    },
    sourceSchemaVersion() { return "csaf-2.0-rolie-json-v1"; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeSiemensProductCertEntry(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "Siemens ProductCERT ROLIE feed failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedSource, type SourceHttpResponse } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CATALOG_ENTRIES = 5_000;
const CATALOG_WORK_RECORD_LIMIT = MAX_CATALOG_ENTRIES + 1;
const SOURCE_SCHEMA_VERSION = "cisa-kev-json-schema-v1";
const USER_AGENT = "BAYKUSH-Intelligence-Node/0.2 (+https://github.com/CenkCTI/BAYKUSH-Intel-Node)";

export const CISA_KEV_PRIMARY_URL = new URL(
  "https://raw.githubusercontent.com/cisagov/kev-data/develop/known_exploited_vulnerabilities.json",
);
export const CISA_KEV_FALLBACK_URL = new URL(
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json",
);
export const CISA_KEV_CATALOG_URL = "https://www.cisa.gov/known-exploited-vulnerabilities-catalog";

type RetrievalChannel = "GITHUB_OFFICIAL_MIRROR" | "CISA_CANONICAL_FEED";

function validDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

const dateOnlySchema = z.string().refine(validDateOnly, "invalid calendar date");
const cveIdSchema = z.string().regex(/^CVE-[0-9]{4}-[0-9]{4,19}$/);
const cweSchema = z.string().regex(/^CWE-[0-9]+$/);

export const cisaKevEntrySchema = z.object({
  cveID: cveIdSchema,
  vendorProject: z.string().max(2_000),
  product: z.string().max(4_000),
  vulnerabilityName: z.string().max(8_000),
  dateAdded: dateOnlySchema,
  shortDescription: z.string().max(64_000),
  requiredAction: z.string().max(64_000),
  dueDate: dateOnlySchema,
  knownRansomwareCampaignUse: z.string().max(256).optional(),
  notes: z.string().max(64_000).optional(),
  cwes: z.array(cweSchema).max(256).optional(),
}).passthrough();
export type CisaKevEntry = z.infer<typeof cisaKevEntrySchema>;

const catalogSchema = z.object({
  title: z.string().max(2_000).optional(),
  catalogVersion: z.string().min(1).max(128),
  dateReleased: z.string().datetime({ offset: true }),
  count: z.number().int().min(1).max(MAX_CATALOG_ENTRIES),
  vulnerabilities: z.array(cisaKevEntrySchema).min(1).max(MAX_CATALOG_ENTRIES),
}).passthrough();

const manifestSchema = z.object({
  catalogVersion: z.string().min(1).max(128),
  dateReleased: z.string().datetime({ offset: true }),
  count: z.number().int().min(1).max(MAX_CATALOG_ENTRIES),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
  membershipSha256: z.string().regex(/^[a-f0-9]{64}$/),
  cveIds: z.array(cveIdSchema).min(1).max(MAX_CATALOG_ENTRIES),
}).strict();
type CisaKevManifest = z.infer<typeof manifestSchema>;

const retrievalChannelSchema = z.enum(["GITHUB_OFFICIAL_MIRROR", "CISA_CANONICAL_FEED"]);
const checkpointSchema = z.object({
  version: z.literal(1),
  catalogVersion: z.string().min(1).max(128).nullable(),
  dateReleased: z.string().datetime({ offset: true }).nullable(),
  bodySha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  count: z.number().int().min(1).max(MAX_CATALOG_ENTRIES).nullable(),
  retrievalChannel: retrievalChannelSchema.nullable(),
  etag: z.string().max(2_000).nullable(),
  lastModified: z.string().max(2_000).nullable(),
}).strict();
type CisaKevCheckpoint = z.infer<typeof checkpointSchema>;

const fetchedEntrySchema = z.object({
  kind: z.literal("ENTRY"),
  payload: cisaKevEntrySchema,
  retrievalChannel: retrievalChannelSchema,
  retrievalUrl: z.string().url(),
}).strict();
const fetchedManifestSchema = z.object({
  kind: z.literal("MANIFEST"),
  payload: manifestSchema,
  retrievalChannel: retrievalChannelSchema,
  retrievalUrl: z.string().url(),
}).strict();
const fetchedRecordSchema = z.union([fetchedEntrySchema, fetchedManifestSchema]);

type FetchImplementation = typeof fetch;

interface CisaKevAdapterOptions {
  fetchImpl?: FetchImplementation;
  primaryUrl?: URL;
  fallbackUrl?: URL;
}

interface RetrievedUnchanged {
  changed: false;
  checkpoint: CisaKevCheckpoint;
}

interface RetrievedChanged {
  changed: true;
  checkpoint: CisaKevCheckpoint;
  channel: RetrievalChannel;
  retrievalUrl: string;
  entries: CisaKevEntry[];
  manifest: CisaKevManifest;
}

type RetrievedCatalog = RetrievedUnchanged | RetrievedChanged;

const emptyCheckpoint = (): CisaKevCheckpoint => ({
  version: 1,
  catalogVersion: null,
  dateReleased: null,
  bodySha256: null,
  count: null,
  retrievalChannel: null,
  etag: null,
  lastModified: null,
});

function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function membershipSha256(cveIds: readonly string[]): string {
  return sha256Bytes([...cveIds].sort().join("\n"));
}

function scopedKey(prefix: string, ...parts: string[]): string {
  const material = parts.map((part) => part.trim().toLowerCase()).join("\u0000");
  return `${prefix}:cisa-kev:${sha256Bytes(material)}`;
}

function catalogSearchUrl(cveId: string): string {
  const url = new URL(CISA_KEV_CATALOG_URL);
  url.searchParams.set("search_api_fulltext", cveId);
  return url.toString();
}

export function extractCisaKevNoteUrls(notes: string | undefined): string[] {
  if (!notes) return [];
  const matches = notes.match(/https?:\/\/[^\s;]+/gi) ?? [];
  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of matches) {
    const trimmed = candidate.replace(/[\])},.]+$/g, "");
    if (trimmed.length > 2_048) continue;
    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) continue;
      const normalized = parsed.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        output.push(normalized);
      }
    } catch {
      // Notes are source-native prose. Invalid URL-looking fragments remain in raw facts only.
    }
    if (output.length >= 63) break;
  }
  return output;
}

export function validateCisaKevCatalog(payload: unknown) {
  const catalog = catalogSchema.parse(payload);
  if (catalog.count !== catalog.vulnerabilities.length) {
    throw new CollectionFailure("SCHEMA_ERROR", "CISA KEV count does not match vulnerability array length", false);
  }
  const seen = new Set<string>();
  for (const entry of catalog.vulnerabilities) {
    if (seen.has(entry.cveID)) {
      throw new CollectionFailure("SCHEMA_ERROR", "CISA KEV snapshot contains a duplicate CVE identifier", false);
    }
    seen.add(entry.cveID);
  }
  return catalog;
}

export function normalizeCisaKevEntry(entryInput: unknown): CanonicalEvidenceDraft {
  const entry = cisaKevEntrySchema.parse(entryInput);
  const facts: CanonicalEvidenceDraft["facts"] = [
    { predicate: "kev.catalog_membership", value: true },
    { predicate: "kev.cve_id", value: entry.cveID },
    { predicate: "kev.vendor_project", value: entry.vendorProject },
    { predicate: "kev.product", value: entry.product },
    { predicate: "kev.vulnerability_name", value: entry.vulnerabilityName },
    { predicate: "kev.date_added", value: entry.dateAdded },
    { predicate: "kev.due_date", value: entry.dueDate },
    { predicate: "kev.short_description", value: entry.shortDescription },
    { predicate: "kev.required_action", value: entry.requiredAction },
  ];
  if (entry.knownRansomwareCampaignUse !== undefined) {
    facts.push({ predicate: "kev.known_ransomware_campaign_use", value: entry.knownRansomwareCampaignUse });
  }
  if (entry.notes !== undefined) facts.push({ predicate: "kev.notes", value: entry.notes });
  if (entry.cwes !== undefined) facts.push({ predicate: "kev.cwes", value: entry.cwes });

  return {
    recordKind: "KNOWN_EXPLOITED_VULNERABILITY",
    canonicalKey: `cve:${entry.cveID}`,
    entities: [
      { kind: "CVE", key: entry.cveID, label: entry.cveID },
      { kind: "VENDOR", key: scopedKey("vendor", entry.vendorProject), label: entry.vendorProject.trim() || entry.vendorProject },
      { kind: "PRODUCT", key: scopedKey("product", entry.vendorProject, entry.product), label: entry.product.trim() || entry.product },
    ],
    facts,
    references: [catalogSearchUrl(entry.cveID), ...extractCisaKevNoteUrls(entry.notes)].slice(0, 64),
  };
}

function decodeJson(response: SourceHttpResponse): unknown {
  const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType && !["application/json", "text/plain", "application/octet-stream"].includes(mediaType)) {
    throw new CollectionFailure("PROVIDER_ERROR", "CISA KEV returned an unexpected content type", true);
  }
  try {
    return JSON.parse(response.bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new CollectionFailure("PROVIDER_ERROR", "CISA KEV returned invalid JSON", true, { cause: error });
  }
}

function conditionalHeaders(checkpoint: CisaKevCheckpoint, channel: RetrievalChannel): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": USER_AGENT,
  };
  if (checkpoint.retrievalChannel === channel) {
    if (checkpoint.etag) headers["if-none-match"] = checkpoint.etag;
    if (checkpoint.lastModified) headers["if-modified-since"] = checkpoint.lastModified;
  }
  return headers;
}

async function retrieveChannel(input: {
  channel: RetrievalChannel;
  url: URL;
  allowedHost: string;
  allowedPath: string;
  checkpoint: CisaKevCheckpoint;
  signal: AbortSignal;
  fetchImpl?: FetchImplementation;
}): Promise<RetrievedCatalog> {
  const response = await fetchBoundedSource({
    url: input.url,
    allowedHost: input.allowedHost,
    allowedPath: input.allowedPath,
    maxBytes: MAX_CATALOG_BYTES,
    timeoutMs: 30_000,
    acceptedStatuses: [200, 304],
    headers: conditionalHeaders(input.checkpoint, input.channel),
    signal: input.signal,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

  if (response.status === 304) {
    return {
      changed: false,
      checkpoint: {
        ...input.checkpoint,
        retrievalChannel: input.channel,
        etag: response.etag ?? input.checkpoint.etag,
        lastModified: response.lastModified ?? input.checkpoint.lastModified,
      },
    };
  }

  const bodySha256 = sha256Bytes(response.bytes);
  if (input.checkpoint.bodySha256 === bodySha256) {
    return {
      changed: false,
      checkpoint: {
        ...input.checkpoint,
        retrievalChannel: input.channel,
        etag: response.etag,
        lastModified: response.lastModified,
      },
    };
  }

  let catalog;
  try {
    catalog = validateCisaKevCatalog(decodeJson(response));
  } catch (error) {
    if (error instanceof CollectionFailure) throw error;
    if (error instanceof z.ZodError) {
      throw new CollectionFailure("SCHEMA_ERROR", "CISA KEV snapshot failed its published schema contract", false, { cause: error });
    }
    throw error;
  }

  const cveIds = catalog.vulnerabilities.map((entry) => entry.cveID).sort();
  const manifest: CisaKevManifest = {
    catalogVersion: catalog.catalogVersion,
    dateReleased: catalog.dateReleased,
    count: catalog.count,
    bodySha256,
    membershipSha256: membershipSha256(cveIds),
    cveIds,
  };
  const checkpoint: CisaKevCheckpoint = {
    version: 1,
    catalogVersion: catalog.catalogVersion,
    dateReleased: catalog.dateReleased,
    bodySha256,
    count: catalog.count,
    retrievalChannel: input.channel,
    etag: response.etag,
    lastModified: response.lastModified,
  };
  return {
    changed: true,
    checkpoint,
    channel: input.channel,
    retrievalUrl: input.url.toString(),
    entries: catalog.vulnerabilities,
    manifest,
  };
}

export function createCisaKevAdapter(options: CisaKevAdapterOptions = {}): SourceAdapter {
  const primaryUrl = options.primaryUrl ?? CISA_KEV_PRIMARY_URL;
  const fallbackUrl = options.fallbackUrl ?? CISA_KEV_FALLBACK_URL;

  return {
    definition: {
      sourceKey: "CISA_KEV",
      displayName: "CISA Known Exploited Vulnerabilities",
      providerName: "Cybersecurity and Infrastructure Security Agency (CISA)",
      upstreamOriginKey: "CISA_KEV",
      sourceClass: "EXPLOITED_VULNERABILITY_CATALOG",
      observationBasis: "PUBLISHED",
      authorityType: "GOVERNMENT",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 3_600,
      minimumPollIntervalSeconds: 900,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "SNAPSHOT_RECONSTRUCTION",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      credentialKind: null,
      adapterVersion: "cisa-kev-adapter-v1",
      semanticContractVersion: "cisa-kev-semantics-v1",
      licenseClass: "CC0-1.0",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "CC0 does not require attribution; do not imply CISA/DHS endorsement or use CISA/DHS marks as endorsement.",
      termsReference: "https://www.cisa.gov/sites/default/files/licenses/kev/license.txt",
      semanticBoundary: {
        represents: "Vulnerabilities published by CISA in the Known Exploited Vulnerabilities catalog as known to have been exploited in the wild.",
        doesNotRepresent: "Direct BAYKUSH sensor observations, exploit-event counts, victim counts, global attack volume, a universal remediation deadline, or proof that exploitation ceased after catalog removal. Ransomware value Unknown is not No.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: CATALOG_WORK_RECORD_LIMIT,
    normalizationVersion: "cisa-kev-normalization-v1",
    checkpointSchemaVersion: "cisa-kev-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) {
      return checkpoint === null ? emptyCheckpoint() : checkpointSchema.parse(checkpoint);
    },
    async fetch({ work, signal }) {
      const checkpoint = checkpointSchema.parse(work);
      let retrieved: RetrievedCatalog;
      try {
        retrieved = await retrieveChannel({
          channel: "GITHUB_OFFICIAL_MIRROR",
          url: primaryUrl,
          allowedHost: primaryUrl.hostname,
          allowedPath: primaryUrl.pathname,
          checkpoint,
          signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
      } catch (primaryError) {
        try {
          retrieved = await retrieveChannel({
            channel: "CISA_CANONICAL_FEED",
            url: fallbackUrl,
            allowedHost: fallbackUrl.hostname,
            allowedPath: fallbackUrl.pathname,
            checkpoint,
            signal,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
        } catch (fallbackError) {
          if (fallbackError instanceof CollectionFailure) throw fallbackError;
          if (primaryError instanceof CollectionFailure) throw primaryError;
          throw fallbackError;
        }
      }

      if (!retrieved.changed) {
        return { records: [], nextWork: null, nextCheckpoint: retrieved.checkpoint, complete: true };
      }
      const records = [
        ...retrieved.entries.map((payload) => ({
          kind: "ENTRY" as const,
          payload,
          retrievalChannel: retrieved.channel,
          retrievalUrl: retrieved.retrievalUrl,
        })),
        {
          kind: "MANIFEST" as const,
          payload: retrieved.manifest,
          retrievalChannel: retrieved.channel,
          retrievalUrl: retrieved.retrievalUrl,
        },
      ];
      return { records, nextWork: null, nextCheckpoint: retrieved.checkpoint, complete: true };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.kind === "ENTRY" ? parsed.payload.cveID : "__catalog_manifest__";
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") {
        return { publishedAt: parsed.payload.dateReleased, effectiveAt: parsed.payload.dateReleased, upstreamUpdatedAt: null };
      }
      // dateAdded/dueDate are date-only source facts. Do not invent midnight precision.
      return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
    },
    sourceReference(record) {
      return fetchedRecordSchema.parse(record).retrievalUrl;
    },
    sourceSchemaVersion() {
      return SOURCE_SCHEMA_VERSION;
    },
    rawPayload(record) {
      return fetchedRecordSchema.parse(record).payload;
    },
    normalize(record) {
      const manifest = manifestSchema.safeParse(record);
      if (manifest.success) return [];
      return [normalizeCisaKevEntry(record)];
    },
    classifyFailure(error) {
      if (error instanceof z.ZodError) {
        return { code: "SCHEMA_ERROR", retryable: false, message: "CISA KEV data failed validation" };
      }
      return classifyUnknownFailure(error);
    },
  };
}

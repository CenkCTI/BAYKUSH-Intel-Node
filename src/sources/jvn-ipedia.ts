import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedSource, type SourceHttpResponse } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

const NEW_FEED_URL = new URL("https://jvndb.jvn.jp/en/rss/jvndb_new.rdf");
const UPDATED_FEED_URL = new URL("https://jvndb.jvn.jp/en/rss/jvndb.rdf");
const PUBLIC_REFERENCE = "https://jvndb.jvn.jp/en/feed/";
const TERMS_REFERENCE = "https://jvn.jp/en/rss/";
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 1_000;

const referenceSchema = z.object({
  source: z.string().max(128).nullable(),
  id: z.string().max(256).nullable(),
  url: z.string().url().nullable(),
}).strict();

const entrySchema = z.object({
  identifier: z.string().min(1).max(256),
  title: z.string().min(1).max(4096),
  link: z.string().url(),
  description: z.string().max(64_000).nullable(),
  publisher: z.string().max(1024).nullable(),
  issued: z.string().max(64).nullable(),
  modified: z.string().max(64).nullable(),
  references: z.array(referenceSchema).max(128),
}).strict();
type JvnEntry = z.infer<typeof entrySchema>;

const persistedEntrySchema = z.object({ kind: z.literal("JVN_IPEDIA_ENTRY"), source: entrySchema }).strict();
const manifestSchema = z.object({
  kind: z.literal("JVN_IPEDIA_MANIFEST"),
  entryCount: z.number().int().nonnegative().max(MAX_ENTRIES),
  newFeedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  updatedFeedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const payloadSchema = z.discriminatedUnion("kind", [persistedEntrySchema, manifestSchema]);
const fetchedRecordSchema = z.object({ kind: z.enum(["ENTRY", "MANIFEST"]), payload: payloadSchema }).strict();
const checkpointSchema = z.object({
  version: z.literal(1),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  newFeedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  updatedFeedSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  entryCount: z.number().int().nonnegative().max(MAX_ENTRIES).nullable(),
}).strict();

type UnknownRecord = Record<string, unknown>;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function scalar(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    return text ? text : null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) return scalar(value["#text"]);
  return null;
}

function attribute(value: unknown, name: string): string | null {
  if (!isRecord(value)) return null;
  return scalar(value[`@_${name}`]);
}

function normalizeSourceTime(value: string | null, field: string): string | null {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new CollectionFailure("SCHEMA_ERROR", `JVN iPedia ${field} is not a valid source timestamp`, false);
  }
  return new Date(milliseconds).toISOString();
}

function parseReference(value: unknown): z.infer<typeof referenceSchema> | null {
  const text = scalar(value);
  const candidate = {
    source: attribute(value, "source"),
    id: attribute(value, "id"),
    url: text && /^https?:\/\//i.test(text) ? text : null,
  };
  const parsed = referenceSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function parseItem(value: unknown): JvnEntry {
  if (!isRecord(value)) throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia feed item is not an object", false);
  const identifier = scalar(value["sec:identifier"]);
  const title = scalar(value.title);
  const link = scalar(value.link) ?? attribute(value, "rdf:about");
  if (!identifier || !title || !link) {
    throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia item lacks identifier, title, or link", false);
  }
  const references = asArray(value["sec:references"])
    .map(parseReference)
    .filter((reference): reference is z.infer<typeof referenceSchema> => reference !== null);
  return entrySchema.parse({
    identifier,
    title,
    link,
    description: scalar(value.description),
    publisher: scalar(value["dc:publisher"]),
    issued: scalar(value["dcterms:issued"]),
    modified: scalar(value["dcterms:modified"]) ?? scalar(value["dc:date"]),
    references,
  });
}

export function parseJvnIpediaFeed(xml: string): JvnEntry[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xml) as unknown;
  } catch (error) {
    throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia feed is not valid XML", false, { cause: error });
  }
  if (!isRecord(parsed)) throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia XML root is invalid", false);
  const root = parsed["rdf:RDF"];
  if (!isRecord(root)) throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia feed lacks rdf:RDF root", false);
  const entries = asArray(root.item).map(parseItem);
  if (entries.length > MAX_ENTRIES) {
    throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `JVN iPedia recent feed exceeds the configured entry bound (${entries.length} > ${MAX_ENTRIES})`, false);
  }
  return entries;
}

function assertXmlMediaType(response: SourceHttpResponse): void {
  const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mediaType) return;
  if (!["application/rdf+xml", "application/xml", "text/xml"].includes(mediaType)) {
    throw new CollectionFailure("PROVIDER_ERROR", "JVN iPedia feed returned an unexpected content type", true);
  }
}

function preferEntry(left: JvnEntry, right: JvnEntry): JvnEntry {
  const leftModified = left.modified === null ? Number.NEGATIVE_INFINITY : Date.parse(left.modified);
  const rightModified = right.modified === null ? Number.NEGATIVE_INFINITY : Date.parse(right.modified);
  return rightModified > leftModified ? right : left;
}

function mergeEntries(...groups: readonly JvnEntry[][]): JvnEntry[] {
  const merged = new Map<string, JvnEntry>();
  for (const group of groups) {
    for (const entry of group) {
      const existing = merged.get(entry.identifier);
      merged.set(entry.identifier, existing ? preferEntry(existing, entry) : entry);
    }
  }
  return [...merged.values()].sort((left, right) => left.identifier.localeCompare(right.identifier));
}

function snapshotFingerprint(entries: readonly JvnEntry[]): string {
  return sha256(entries.map((entry) => `${entry.identifier}:${sha256(canonicalJsonStringify(entry))}\n`).join(""));
}

function cveIds(entry: JvnEntry): string[] {
  const values = new Set<string>();
  for (const reference of entry.references) {
    for (const candidate of [reference.id, reference.url]) {
      if (!candidate) continue;
      const matches = candidate.match(/CVE-\d{4}-\d{4,}/gi) ?? [];
      for (const match of matches) values.add(match.toUpperCase());
    }
  }
  return [...values].sort();
}

export function normalizeJvnIpediaPayload(input: unknown): CanonicalEvidenceDraft[] {
  const payload = payloadSchema.parse(input);
  if (payload.kind === "JVN_IPEDIA_MANIFEST") return [];
  const source = payload.source;
  const issuedAt = normalizeSourceTime(source.issued, "issued");
  const modifiedAt = normalizeSourceTime(source.modified, "modified");
  const entities = cveIds(source).map((cve) => ({ kind: "CVE" as const, key: cve, label: cve }));
  const referenceUrls = source.references.map((reference) => reference.url).filter((url): url is string => url !== null);
  return [{
    recordKind: "SECURITY_ADVISORY",
    canonicalKey: `security-advisory:jvn-ipedia:${source.identifier.toLowerCase()}`,
    entities,
    facts: [
      { predicate: "jvn_ipedia.identifier", value: source.identifier },
      { predicate: "jvn_ipedia.title", value: source.title },
      { predicate: "jvn_ipedia.description", value: source.description },
      { predicate: "jvn_ipedia.publisher", value: source.publisher },
      { predicate: "jvn_ipedia.issued_at", value: issuedAt },
      { predicate: "jvn_ipedia.modified_at", value: modifiedAt },
      { predicate: "jvn_ipedia.references", value: source.references },
    ],
    references: [...new Set([source.link, ...referenceUrls])].slice(0, 100),
  }];
}

export function createJvnIpediaAdapter(options: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    definition: {
      sourceKey: "JVN_IPEDIA",
      displayName: "JVN iPedia Recent Vulnerability Advisories",
      providerName: "JVN iPedia (IPA / JPCERT/CC)",
      upstreamOriginKey: "JVN_IPEDIA",
      sourceClass: "VULNERABILITY_DATABASE",
      observationBasis: "PUBLISHED",
      authorityType: "NATIONAL_VULNERABILITY_DATABASE",
      collectionMode: "POLL",
      defaultPollIntervalSeconds: 3600,
      minimumPollIntervalSeconds: 900,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "LIVE_ONLY",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "jvn-ipedia-adapter-v1",
      semanticContractVersion: "jvn-ipedia-semantics-v1",
      licenseClass: "JVN_FEED_TERMS",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "RESTRICTED",
      attributionRequirement: "Retain JVN/JVN iPedia source attribution and source links; syndicated feed content should not be represented as more current than the publisher source.",
      termsReference: TERMS_REFERENCE,
      semanticBoundary: {
        represents: "Vulnerability countermeasure entries exposed by the official English JVN iPedia new and new/updated JVNRSS feeds.",
        doesNotRepresent: "A complete historical advisory corpus, independent exploitation confirmation, attack count, organization exposure, business risk, or global threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_ENTRIES + 1,
    maxRawRecordBytes: 512 * 1024,
    normalizationVersion: "jvn-ipedia-normalization-v1",
    checkpointSchemaVersion: "jvn-ipedia-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) {
      return checkpoint === null
        ? { version: 1, snapshotFingerprint: null, newFeedSha256: null, updatedFeedSha256: null, entryCount: null }
        : checkpointSchema.parse(checkpoint);
    },
    async fetch({ work, signal }) {
      const prior = checkpointSchema.parse(work);
      const request = async (url: URL): Promise<SourceHttpResponse> => {
        const response = await fetchBoundedSource({
          url,
          allowedHost: url.hostname,
          allowedPath: url.pathname,
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: 20_000,
          signal,
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        });
        assertXmlMediaType(response);
        return response;
      };
      const [newResponse, updatedResponse] = await Promise.all([request(NEW_FEED_URL), request(UPDATED_FEED_URL)]);
      const newFeedSha256 = sha256(newResponse.bytes);
      const updatedFeedSha256 = sha256(updatedResponse.bytes);
      const entries = mergeEntries(
        parseJvnIpediaFeed(newResponse.bytes.toString("utf8")),
        parseJvnIpediaFeed(updatedResponse.bytes.toString("utf8")),
      );
      if (entries.length > MAX_ENTRIES) {
        throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `JVN iPedia merged recent feeds exceed the configured entry bound (${entries.length} > ${MAX_ENTRIES})`, false);
      }
      const fingerprint = snapshotFingerprint(entries);
      const nextCheckpoint = {
        version: 1 as const,
        snapshotFingerprint: fingerprint,
        newFeedSha256,
        updatedFeedSha256,
        entryCount: entries.length,
      };
      if (prior.snapshotFingerprint === fingerprint) return { records: [], nextWork: null, nextCheckpoint, complete: true };
      const manifest = manifestSchema.parse({ kind: "JVN_IPEDIA_MANIFEST", entryCount: entries.length, newFeedSha256, updatedFeedSha256, snapshotFingerprint: fingerprint });
      return {
        records: [
          ...entries.map((source) => ({ kind: "ENTRY" as const, payload: { kind: "JVN_IPEDIA_ENTRY" as const, source } })),
          { kind: "MANIFEST" as const, payload: manifest },
        ],
        nextWork: null,
        nextCheckpoint,
        complete: true,
      };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") return "__jvn_ipedia_recent_manifest__";
      if (parsed.payload.kind !== "JVN_IPEDIA_ENTRY") throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia record kind mismatch", false);
      return parsed.payload.source.identifier;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
      if (parsed.payload.kind !== "JVN_IPEDIA_ENTRY") throw new CollectionFailure("SCHEMA_ERROR", "JVN iPedia record kind mismatch", false);
      const source = parsed.payload.source;
      const issuedAt = normalizeSourceTime(source.issued, "issued");
      return { publishedAt: issuedAt, effectiveAt: issuedAt, upstreamUpdatedAt: normalizeSourceTime(source.modified, "modified") };
    },
    sourceReference(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.kind === "MANIFEST" || parsed.payload.kind !== "JVN_IPEDIA_ENTRY" ? PUBLIC_REFERENCE : parsed.payload.source.link;
    },
    sourceSchemaVersion() { return "jvn-ipedia-jvnrss-v2.2"; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeJvnIpediaPayload(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "JVN iPedia feed failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

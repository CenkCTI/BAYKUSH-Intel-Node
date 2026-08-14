import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedSource } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

const FEED_URL = new URL("https://cert.europa.eu/publications/security-advisories-rss");
const TERMS_REFERENCE = "https://cert.europa.eu/legal-notice";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_ITEMS = 250;

type UnknownRecord = Record<string, unknown>;

const publicationSchema = z.object({
  serialNumber: z.string().regex(/^\d{4}-\d{3}$/),
  title: z.string().min(1).max(8_192),
  url: z.string().url(),
  publishedAt: z.string().datetime({ offset: true }),
  description: z.string().max(256_000).nullable(),
}).strict();
type Publication = z.infer<typeof publicationSchema>;

const publicationPayloadSchema = z.object({
  kind: z.literal("CERT_EU_PUBLICATION"),
  source: publicationSchema,
}).strict();

const manifestSchema = z.object({
  kind: z.literal("CERT_EU_PUBLICATION_MANIFEST"),
  itemCount: z.number().int().nonnegative().max(MAX_ITEMS),
  responseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const persistedPayloadSchema = z.discriminatedUnion("kind", [publicationPayloadSchema, manifestSchema]);
const fetchedRecordSchema = z.object({ kind: z.enum(["PUBLICATION", "MANIFEST"]), payload: persistedPayloadSchema }).strict();
const checkpointSchema = z.object({
  version: z.literal(1),
  snapshotFingerprint: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  responseSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  itemCount: z.number().int().nonnegative().max(MAX_ITEMS).nullable(),
}).strict();

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
});

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) return text(value["#text"]);
  return null;
}

function serialFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "cert.europa.eu") return null;
    return /^\/publications\/security-advisories\/(\d{4}-\d{3})\/?$/.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function publicationTime(value: string): string {
  const normalized = value.trim()
    .replace(/\sCEST$/i, " +0200")
    .replace(/\sCET$/i, " +0100");
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds)) throw new CollectionFailure("SCHEMA_ERROR", "CERT-EU feed publication time is invalid", false);
  return new Date(milliseconds).toISOString();
}

export function parseCertEuSecurityAdvisoryFeed(xml: string): Publication[] {
  let root: unknown;
  try {
    root = parser.parse(xml) as unknown;
  } catch (error) {
    throw new CollectionFailure("SCHEMA_ERROR", "CERT-EU security advisory feed is invalid XML", false, { cause: error });
  }
  if (!isRecord(root) || !isRecord(root.rss) || !isRecord(root.rss.channel)) {
    throw new CollectionFailure("SCHEMA_ERROR", "CERT-EU security advisory feed lacks an RSS channel", false);
  }

  const publications = new Map<string, Publication>();
  for (const raw of asArray(root.rss.channel.item)) {
    if (!isRecord(raw)) continue;
    const title = text(raw.title);
    const url = text(raw.link);
    const rawDate = text(raw.pubDate) ?? text(raw["dc:date"]);
    if (!title || !url || !rawDate) continue;
    const serialNumber = serialFromUrl(url);
    if (!serialNumber) continue;
    publications.set(serialNumber, publicationSchema.parse({
      serialNumber,
      title,
      url: new URL(url).toString(),
      publishedAt: publicationTime(rawDate),
      description: text(raw.description),
    }));
  }

  if (publications.size > MAX_ITEMS) {
    throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", "CERT-EU feed exceeds the configured item bound", false);
  }
  return [...publications.values()].sort((left, right) => left.serialNumber.localeCompare(right.serialNumber));
}

function fingerprint(publications: readonly Publication[]): string {
  return sha256(publications.map((publication) => `${publication.serialNumber}:${sha256(canonicalJsonStringify(publication))}\n`).join(""));
}

function cveIds(publication: Publication): string[] {
  const haystack = `${publication.title}\n${publication.description ?? ""}`;
  return [...new Set((haystack.match(/CVE-\d{4}-\d{4,19}/gi) ?? []).map((value) => value.toUpperCase()))].sort();
}

export function normalizeCertEuPublication(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "CERT_EU_PUBLICATION_MANIFEST") return [];
  const source = payload.source;
  const cves = cveIds(source);
  return [{
    recordKind: "CERT_CSIRT_PUBLICATION",
    canonicalKey: `cert-publication:cert-eu:${source.serialNumber}`,
    entities: cves.map((cve) => ({ kind: "CVE" as const, key: cve, label: cve })),
    facts: [
      { predicate: "cert_eu.serial_number", value: source.serialNumber },
      { predicate: "cert_eu.title", value: source.title },
      { predicate: "cert_eu.description", value: source.description },
      { predicate: "cert_eu.published_at", value: source.publishedAt },
      { predicate: "cert_eu.cves_in_feed_item", value: cves },
    ],
    references: [source.url],
  }];
}

export function createCertEuPublicationAdapter(options: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    definition: {
      sourceKey: "CERT_EU_SECURITY_ADVISORY",
      displayName: "CERT-EU Security Advisory Publications",
      providerName: "CERT-EU",
      upstreamOriginKey: "CERT_EU_SECURITY_ADVISORY_RSS",
      sourceClass: "CERT_CSIRT_REPORTING",
      observationBasis: "PUBLISHED",
      authorityType: "EU_CERT",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 3_600,
      minimumPollIntervalSeconds: 900,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "LIVE_ONLY",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "cert-eu-publication-adapter-v1",
      semanticContractVersion: "cert-eu-publication-semantics-v1",
      licenseClass: "CC-BY-4.0",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "ALLOWED",
      attributionRequirement: "Give appropriate CERT-EU credit, indicate changes and clear third-party rights where the publication includes separately protected material.",
      termsReference: TERMS_REFERENCE,
      semanticBoundary: {
        represents: "Security-advisory publications syndicated by CERT-EU on its official category feed.",
        doesNotRepresent: "The full advisory body, a complete vulnerability database, independent exploitation confirmation, attack or victim count, organization exposure, business risk, attribution truth, or global threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_ITEMS + 1,
    maxRawRecordBytes: 512 * 1024,
    normalizationVersion: "cert-eu-publication-normalization-v1",
    checkpointSchemaVersion: "cert-eu-publication-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) {
      return checkpoint === null
        ? { version: 1, snapshotFingerprint: null, responseSha256: null, itemCount: null }
        : checkpointSchema.parse(checkpoint);
    },
    async fetch({ work, signal }) {
      const prior = checkpointSchema.parse(work);
      const response = await fetchBoundedSource({
        url: FEED_URL,
        allowedHost: FEED_URL.hostname,
        allowedPath: FEED_URL.pathname,
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: 20_000,
        signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      const publications = parseCertEuSecurityAdvisoryFeed(response.bytes.toString("utf8"));
      const responseSha256 = sha256(response.bytes);
      const snapshotFingerprint = fingerprint(publications);
      const nextCheckpoint = { version: 1 as const, snapshotFingerprint, responseSha256, itemCount: publications.length };
      if (prior.snapshotFingerprint === snapshotFingerprint) {
        return { records: [], nextWork: null, nextCheckpoint, complete: true };
      }
      return {
        records: [
          ...publications.map((source) => ({ kind: "PUBLICATION" as const, payload: { kind: "CERT_EU_PUBLICATION" as const, source } })),
          { kind: "MANIFEST" as const, payload: manifestSchema.parse({ kind: "CERT_EU_PUBLICATION_MANIFEST", itemCount: publications.length, responseSha256, snapshotFingerprint }) },
        ],
        nextWork: null,
        nextCheckpoint,
        complete: true,
      };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.payload.kind === "CERT_EU_PUBLICATION_MANIFEST" ? "__cert_eu_publication_manifest__" : parsed.payload.source.serialNumber;
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.payload.kind === "CERT_EU_PUBLICATION_MANIFEST") return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
      return { publishedAt: parsed.payload.source.publishedAt, effectiveAt: parsed.payload.source.publishedAt, upstreamUpdatedAt: null };
    },
    sourceReference(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.payload.kind === "CERT_EU_PUBLICATION_MANIFEST" ? FEED_URL.toString() : parsed.payload.source.url;
    },
    sourceSchemaVersion() { return "cert-eu-security-advisory-rss-v1"; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeCertEuPublication(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "CERT-EU publication feed failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

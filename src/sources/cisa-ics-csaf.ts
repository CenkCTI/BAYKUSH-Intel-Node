import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson, fetchBoundedSource } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

const BRANCH_URL = new URL("https://api.github.com/repos/cisagov/CSAF/branches/develop");
const RAW_HOST = "raw.githubusercontent.com";
const SOURCE_REFERENCE = "https://github.com/cisagov/CSAF";
const TERMS_REFERENCE = "https://www.cisa.gov/notification";
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const MAX_ADVISORY_BYTES = 4 * 1024 * 1024;
const MAX_CHANGED_ENTRIES = 5_000;
const PAGE_SIZE = 10;
const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);

const branchSchema = z.object({
  commit: z.object({
    sha: shaSchema,
    commit: z.object({ tree: z.object({ sha: shaSchema }) }).passthrough(),
  }).passthrough(),
}).passthrough();

const treeEntrySchema = z.object({
  path: z.string().min(1).max(1_024),
  type: z.enum(["blob", "tree"]),
  sha: shaSchema,
  size: z.number().int().nonnegative().optional(),
}).passthrough();
export type CisaCsafTreeEntry = z.infer<typeof treeEntrySchema>;

const treeResponseSchema = z.object({
  sha: shaSchema,
  truncated: z.boolean().optional(),
  tree: z.array(treeEntrySchema).max(30_000),
}).passthrough();

const referenceSchema = z.object({
  category: z.string().max(64).optional(),
  summary: z.string().max(4_096).optional(),
  url: z.string().url(),
}).passthrough();

const noteSchema = z.object({
  category: z.string().max(128),
  title: z.string().max(512).optional(),
  text: z.string().max(256_000),
}).passthrough();

const vulnerabilitySchema = z.object({
  cve: z.string().regex(/^CVE-\d{4}-\d{4,19}$/).optional(),
  cwe: z.object({ id: z.string().max(64), name: z.string().max(1_024).optional() }).passthrough().optional(),
  references: z.array(referenceSchema).max(128).optional(),
}).passthrough();

export const cisaIcsCsafSchema = z.object({
  document: z.object({
    category: z.literal("csaf_security_advisory"),
    csaf_version: z.literal("2.0"),
    title: z.string().min(1).max(8_192),
    publisher: z.object({
      name: z.string().min(1).max(1_024),
      category: z.string().max(128).optional(),
      namespace: z.string().url().optional(),
    }).passthrough(),
    tracking: z.object({
      id: z.string().min(1).max(128),
      initial_release_date: z.string().datetime({ offset: true }),
      current_release_date: z.string().datetime({ offset: true }),
      status: z.string().max(64),
      version: z.string().max(64),
      revision_history: z.array(z.unknown()).max(256).optional(),
    }).passthrough(),
    references: z.array(referenceSchema).max(256).optional(),
    notes: z.array(noteSchema).max(512).optional(),
    distribution: z.unknown().optional(),
  }).passthrough(),
  product_tree: z.unknown().optional(),
  vulnerabilities: z.array(vulnerabilitySchema).max(512).optional(),
}).passthrough();
type CisaIcsCsaf = z.infer<typeof cisaIcsCsafSchema>;

const advisoryPayloadSchema = z.object({
  kind: z.literal("CISA_ICS_CSAF_ADVISORY"),
  source: cisaIcsCsafSchema,
  sourcePath: z.string().min(1).max(1_024),
  sourceCommitSha: shaSchema,
  blobSha: shaSchema,
}).strict();

const manifestSchema = z.object({
  kind: z.literal("CISA_ICS_CSAF_MANIFEST"),
  sourceCommitSha: shaSchema,
  whiteTreeSha: shaSchema,
  advisoryCount: z.number().int().nonnegative().max(MAX_CHANGED_ENTRIES),
  changedCount: z.number().int().nonnegative().max(MAX_CHANGED_ENTRIES),
  removedCount: z.number().int().nonnegative().max(MAX_CHANGED_ENTRIES),
  entriesSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

const persistedPayloadSchema = z.discriminatedUnion("kind", [advisoryPayloadSchema, manifestSchema]);
const fetchedRecordSchema = z.object({
  kind: z.enum(["ADVISORY", "MANIFEST"]),
  payload: persistedPayloadSchema,
}).strict();

const pageEntrySchema = z.object({
  path: z.string().regex(/^\d{4}\/ics(?:a|ma)-\d{2}-\d{3}-\d{2,3}\.json$/i),
  sha: shaSchema,
  size: z.number().int().nonnegative().max(MAX_ADVISORY_BYTES).nullable(),
}).strict();

type PageEntry = z.infer<typeof pageEntrySchema>;

const pageWorkSchema = z.object({
  version: z.literal(1),
  mode: z.literal("PAGE"),
  sourceCommitSha: shaSchema,
  whiteTreeSha: shaSchema,
  previousWhiteTreeSha: shaSchema.nullable(),
  entries: z.array(pageEntrySchema).max(MAX_CHANGED_ENTRIES),
  removedCount: z.number().int().nonnegative().max(MAX_CHANGED_ENTRIES),
  offset: z.number().int().nonnegative().max(MAX_CHANGED_ENTRIES),
}).strict();

const discoverWorkSchema = z.object({
  version: z.literal(1),
  mode: z.literal("DISCOVER"),
  previousWhiteTreeSha: shaSchema.nullable(),
}).strict();

const workDescriptorSchema = z.discriminatedUnion("mode", [discoverWorkSchema, pageWorkSchema]);
type PageWork = z.infer<typeof pageWorkSchema>;

const checkpointSchema = z.object({
  version: z.literal(1),
  completedCommitSha: shaSchema.nullable(),
  completedWhiteTreeSha: shaSchema.nullable(),
  activeWork: pageWorkSchema.nullable(),
}).strict();
type Checkpoint = z.infer<typeof checkpointSchema>;

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function githubHeaders(): Record<string, string> {
  return { Accept: "application/vnd.github+json", "User-Agent": "BAYKUSH-Intelligence-Node" };
}

async function fetchGitHubJson(url: URL, maxBytes: number, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<unknown> {
  const response = await fetchBoundedJson({
    url,
    allowedHost: url.hostname,
    allowedPath: url.pathname,
    maxBytes,
    timeoutMs: 20_000,
    headers: githubHeaders(),
    signal,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (response.json === null) throw new CollectionFailure("PROVIDER_ERROR", "CISA CSAF GitHub API returned an empty body", true);
  return response.json;
}

async function fetchTree(treeSha: string, recursive: boolean, signal: AbortSignal, fetchImpl?: typeof fetch) {
  const url = new URL(`https://api.github.com/repos/cisagov/CSAF/git/trees/${treeSha}`);
  if (recursive) url.searchParams.set("recursive", "1");
  const parsed = treeResponseSchema.parse(await fetchGitHubJson(url, MAX_TREE_BYTES, signal, fetchImpl));
  if (parsed.truncated) throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", "CISA CSAF Git tree response was truncated", false);
  return parsed;
}

function requiredSubtree(tree: z.infer<typeof treeResponseSchema>, name: string): string {
  const entry = tree.tree.find((candidate) => candidate.type === "tree" && candidate.path === name);
  if (!entry) throw new CollectionFailure("SCHEMA_ERROR", `CISA CSAF repository is missing expected ${name} subtree`, false);
  return entry.sha;
}

async function resolveSnapshot(signal: AbortSignal, fetchImpl?: typeof fetch): Promise<{ sourceCommitSha: string; whiteTreeSha: string }> {
  const branch = branchSchema.parse(await fetchGitHubJson(BRANCH_URL, 2 * 1024 * 1024, signal, fetchImpl));
  const root = await fetchTree(branch.commit.commit.tree.sha, false, signal, fetchImpl);
  const csaf = await fetchTree(requiredSubtree(root, "csaf_files"), false, signal, fetchImpl);
  const ot = await fetchTree(requiredSubtree(csaf, "OT"), false, signal, fetchImpl);
  return { sourceCommitSha: branch.commit.sha, whiteTreeSha: requiredSubtree(ot, "white") };
}

export function filterCisaIcsCsafEntries(entries: readonly CisaCsafTreeEntry[]): PageEntry[] {
  const selected: PageEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    const candidate = pageEntrySchema.safeParse({ path: entry.path, sha: entry.sha, size: entry.size ?? null });
    if (candidate.success) selected.push(candidate.data);
  }
  selected.sort((left, right) => left.path.localeCompare(right.path));
  if (selected.length > MAX_CHANGED_ENTRIES) {
    throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", "CISA CSAF OT advisory corpus exceeds configured path bound", false);
  }
  return selected;
}

export function changedCisaIcsCsafEntries(current: readonly PageEntry[], previous: readonly PageEntry[]): { changed: PageEntry[]; removedCount: number } {
  const previousMap = new Map(previous.map((entry) => [entry.path, entry.sha]));
  const currentPaths = new Set(current.map((entry) => entry.path));
  const changed = current.filter((entry) => previousMap.get(entry.path) !== entry.sha);
  const removedCount = previous.filter((entry) => !currentPaths.has(entry.path)).length;
  return { changed, removedCount };
}

function entriesFingerprint(entries: readonly PageEntry[]): string {
  return sha256(entries.map((entry) => `${entry.path}:${entry.sha}\n`).join(""));
}

function safeReferences(source: CisaIcsCsaf): string[] {
  const output: string[] = [];
  const add = (value: string) => {
    if (output.length >= 100 || output.includes(value)) return;
    output.push(value);
  };
  for (const reference of source.document.references ?? []) add(reference.url);
  for (const vulnerability of source.vulnerabilities ?? []) {
    for (const reference of vulnerability.references ?? []) add(reference.url);
  }
  return output;
}

function sourceWebReference(source: CisaIcsCsaf): string | null {
  const references = safeReferences(source);
  return references.find((url) => url.startsWith("https://www.cisa.gov/news-events/ics-advisories/")) ?? references[0] ?? null;
}

function criticalSectors(source: CisaIcsCsaf): string[] {
  const sectors = new Set<string>();
  for (const note of source.document.notes ?? []) {
    if ((note.title ?? "").toLowerCase() !== "critical infrastructure sectors") continue;
    for (const value of note.text.split(",")) {
      const trimmed = value.trim();
      if (trimmed) sectors.add(trimmed);
    }
  }
  return [...sectors].sort();
}

export function normalizeCisaIcsCsafPayload(input: unknown): CanonicalEvidenceDraft[] {
  const payload = persistedPayloadSchema.parse(input);
  if (payload.kind === "CISA_ICS_CSAF_MANIFEST") return [];
  const source = payload.source;
  const cves = [...new Set((source.vulnerabilities ?? []).map((vulnerability) => vulnerability.cve).filter((value): value is string => Boolean(value)))].sort();
  const cwes = [...new Set((source.vulnerabilities ?? []).map((vulnerability) => vulnerability.cwe?.id).filter((value): value is string => Boolean(value)))].sort();
  return [{
    recordKind: "SECURITY_ADVISORY",
    canonicalKey: `security-advisory:cisa-ics:${source.document.tracking.id.toLowerCase()}`,
    entities: cves.map((cve) => ({ kind: "CVE" as const, key: cve, label: cve })),
    facts: [
      { predicate: "cisa_ics.advisory_id", value: source.document.tracking.id },
      { predicate: "cisa_ics.title", value: source.document.title },
      { predicate: "cisa_ics.publisher", value: source.document.publisher.name },
      { predicate: "cisa_ics.status", value: source.document.tracking.status },
      { predicate: "cisa_ics.version", value: source.document.tracking.version },
      { predicate: "cisa_ics.initial_release_date", value: source.document.tracking.initial_release_date },
      { predicate: "cisa_ics.current_release_date", value: source.document.tracking.current_release_date },
      { predicate: "cisa_ics.cves", value: cves },
      { predicate: "cisa_ics.cwes", value: cwes },
      { predicate: "cisa_ics.critical_infrastructure_sectors", value: criticalSectors(source) },
      { predicate: "cisa_ics.repository_path", value: payload.sourcePath },
      { predicate: "cisa_ics.repository_commit", value: payload.sourceCommitSha },
    ],
    references: safeReferences(source),
  }];
}

async function fetchRawAdvisory(entry: PageEntry, sourceCommitSha: string, signal: AbortSignal, fetchImpl?: typeof fetch) {
  const url = new URL(`https://${RAW_HOST}/cisagov/CSAF/${sourceCommitSha}/csaf_files/OT/white/${entry.path}`);
  const response = await fetchBoundedSource({
    url,
    allowedHost: RAW_HOST,
    allowedPath: url.pathname,
    maxBytes: MAX_ADVISORY_BYTES,
    timeoutMs: 20_000,
    signal,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new CollectionFailure("SCHEMA_ERROR", "CISA ICS CSAF document is not valid JSON", false, { cause: error });
  }
  return cisaIcsCsafSchema.parse(parsed);
}

export function createCisaIcsCsafAdapter(options: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    definition: {
      sourceKey: "CISA_ICS_CSAF",
      displayName: "CISA ICS CSAF Advisories",
      providerName: "Cybersecurity and Infrastructure Security Agency (CISA)",
      upstreamOriginKey: "CISA_CSAF_OT_WHITE",
      sourceClass: "OFFICIAL_ADVISORY",
      observationBasis: "PUBLISHED",
      authorityType: "GOVERNMENT_COORDINATOR",
      collectionMode: "PAGED_POLL",
      defaultPollIntervalSeconds: 21_600,
      minimumPollIntervalSeconds: 3_600,
      supportsHistoricalRetrieval: true,
      recoveryStrategy: "SNAPSHOT_RECONSTRUCTION",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "cisa-ics-csaf-adapter-v1",
      semanticContractVersion: "cisa-ics-csaf-semantics-v1",
      licenseClass: "CISA_CSAF_MIXED_PUBLISHER",
      commercialUseStatus: "RESTRICTED",
      redistributionStatus: "RESTRICTED",
      attributionRequirement: "Retain CISA and original publisher references. CISA republishes some vendor-partner CSAFs, so downstream redistribution must preserve source-specific notices and must not imply CISA endorsement.",
      termsReference: TERMS_REFERENCE,
      semanticBoundary: {
        represents: "Operational Technology security advisories distributed through CISA's official CSAF repository, including CISA-produced and explicitly republished partner documents.",
        doesNotRepresent: "Independent exploitation confirmation, attack count, victim count, organization exposure, remediation priority, business risk, or global threat level.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: PAGE_SIZE,
    maxRawRecordBytes: MAX_ADVISORY_BYTES,
    normalizationVersion: "cisa-ics-csaf-normalization-v1",
    checkpointSchemaVersion: "cisa-ics-csaf-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema,
    plan({ checkpoint }) {
      if (checkpoint === null) return discoverWorkSchema.parse({ version: 1, mode: "DISCOVER", previousWhiteTreeSha: null });
      const saved = checkpointSchema.parse(checkpoint);
      if (saved.activeWork) return saved.activeWork;
      return discoverWorkSchema.parse({ version: 1, mode: "DISCOVER", previousWhiteTreeSha: saved.completedWhiteTreeSha });
    },
    async fetch({ work, signal }) {
      const descriptor = workDescriptorSchema.parse(work);
      if (descriptor.mode === "DISCOVER") {
        const snapshot = await resolveSnapshot(signal, options.fetchImpl);
        if (descriptor.previousWhiteTreeSha === snapshot.whiteTreeSha) {
          return {
            records: [], nextWork: null,
            nextCheckpoint: { version: 1, completedCommitSha: snapshot.sourceCommitSha, completedWhiteTreeSha: snapshot.whiteTreeSha, activeWork: null },
            complete: true,
          };
        }
        const currentTree = await fetchTree(snapshot.whiteTreeSha, true, signal, options.fetchImpl);
        const current = filterCisaIcsCsafEntries(currentTree.tree);
        const previous = descriptor.previousWhiteTreeSha === null
          ? []
          : filterCisaIcsCsafEntries((await fetchTree(descriptor.previousWhiteTreeSha, true, signal, options.fetchImpl)).tree);
        const delta = changedCisaIcsCsafEntries(current, previous);
        const manifest = manifestSchema.parse({
          kind: "CISA_ICS_CSAF_MANIFEST",
          sourceCommitSha: snapshot.sourceCommitSha,
          whiteTreeSha: snapshot.whiteTreeSha,
          advisoryCount: current.length,
          changedCount: delta.changed.length,
          removedCount: delta.removedCount,
          entriesSha256: entriesFingerprint(current),
        });
        if (delta.changed.length === 0) {
          return {
            records: [{ kind: "MANIFEST" as const, payload: manifest }], nextWork: null,
            nextCheckpoint: { version: 1, completedCommitSha: snapshot.sourceCommitSha, completedWhiteTreeSha: snapshot.whiteTreeSha, activeWork: null },
            complete: true,
          };
        }
        const nextWork = pageWorkSchema.parse({
          version: 1, mode: "PAGE", sourceCommitSha: snapshot.sourceCommitSha,
          whiteTreeSha: snapshot.whiteTreeSha, previousWhiteTreeSha: descriptor.previousWhiteTreeSha,
          entries: delta.changed, removedCount: delta.removedCount, offset: 0,
        });
        return {
          records: [{ kind: "MANIFEST" as const, payload: manifest }], nextWork,
          nextCheckpoint: { version: 1, completedCommitSha: null, completedWhiteTreeSha: descriptor.previousWhiteTreeSha, activeWork: nextWork },
          complete: false,
        };
      }

      const end = Math.min(descriptor.offset + PAGE_SIZE, descriptor.entries.length);
      const batch = descriptor.entries.slice(descriptor.offset, end);
      const sources = await Promise.all(batch.map((entry) => fetchRawAdvisory(entry, descriptor.sourceCommitSha, signal, options.fetchImpl)));
      const records = sources.map((source, index) => {
        const entry = batch[index];
        if (!entry) throw new CollectionFailure("INTERNAL_ERROR", "CISA ICS CSAF page entry mismatch", false);
        return {
          kind: "ADVISORY" as const,
          payload: advisoryPayloadSchema.parse({
            kind: "CISA_ICS_CSAF_ADVISORY",
            source, sourcePath: entry.path, sourceCommitSha: descriptor.sourceCommitSha, blobSha: entry.sha,
          }),
        };
      });
      const complete = end >= descriptor.entries.length;
      const nextWork = complete ? null : pageWorkSchema.parse({ ...descriptor, offset: end });
      const nextCheckpoint: Checkpoint = complete
        ? { version: 1, completedCommitSha: descriptor.sourceCommitSha, completedWhiteTreeSha: descriptor.whiteTreeSha, activeWork: null }
        : { version: 1, completedCommitSha: null, completedWhiteTreeSha: descriptor.previousWhiteTreeSha, activeWork: nextWork };
      return { records, nextWork, nextCheckpoint, complete };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.payload.kind === "CISA_ICS_CSAF_MANIFEST" ? "__cisa_ics_csaf_manifest__" : parsed.payload.source.document.tracking.id.toUpperCase();
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.payload.kind === "CISA_ICS_CSAF_MANIFEST") return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
      const tracking = parsed.payload.source.document.tracking;
      return { publishedAt: tracking.initial_release_date, effectiveAt: tracking.initial_release_date, upstreamUpdatedAt: tracking.current_release_date };
    },
    sourceReference(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.payload.kind === "CISA_ICS_CSAF_MANIFEST") return SOURCE_REFERENCE;
      return sourceWebReference(parsed.payload.source) ?? SOURCE_REFERENCE;
    },
    sourceSchemaVersion() { return "csaf-2.0:cisa-ot-white-v1"; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeCisaIcsCsafPayload(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "CISA ICS CSAF data failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

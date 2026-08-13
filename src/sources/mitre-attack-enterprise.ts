import { createHash } from "node:crypto";
import { z } from "zod";
import type { CanonicalEvidenceDraft } from "../contracts/canonical.js";
import type { SourceAdapter } from "../contracts/source.js";
import { fetchBoundedJson } from "../http/source-http.js";
import { CollectionFailure, classifyUnknownFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

const DATA_URL = new URL("https://raw.githubusercontent.com/mitre-attack/attack-stix-data/master/enterprise-attack/enterprise-attack.json");
const PUBLIC_REFERENCE = "https://attack.mitre.org/resources/attack-data-and-tools/";
const TERMS_REFERENCE = "https://attack.mitre.org/resources/terms-of-use/";
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TECHNIQUES = 10_000;

const externalReferenceSchema = z.object({
  source_name: z.string().min(1).max(256),
  external_id: z.string().max(128).optional(),
  url: z.string().url().optional(),
}).passthrough();

const attackPatternSchema = z.object({
  type: z.literal("attack-pattern"),
  id: z.string().regex(/^attack-pattern--[0-9a-f-]{36}$/i),
  created: z.string().datetime({ offset: true }),
  modified: z.string().datetime({ offset: true }),
  name: z.string().min(1).max(1024),
  description: z.string().max(512_000).optional(),
  revoked: z.boolean().optional(),
  x_mitre_deprecated: z.boolean().optional(),
  x_mitre_version: z.string().max(64).optional(),
  x_mitre_is_subtechnique: z.boolean().optional(),
  x_mitre_platforms: z.array(z.string().max(128)).max(100).optional(),
  external_references: z.array(externalReferenceSchema).max(100),
  kill_chain_phases: z.array(z.object({ kill_chain_name: z.string().max(128), phase_name: z.string().max(128) }).passthrough()).max(100).optional(),
}).passthrough();
type AttackPattern = z.infer<typeof attackPatternSchema>;

const bundleSchema = z.object({
  type: z.literal("bundle"),
  id: z.string().optional(),
  objects: z.array(z.unknown()).max(100_000),
}).passthrough();

const persistedPatternSchema = z.object({ kind: z.literal("MITRE_ATTACK_PATTERN"), source: attackPatternSchema }).strict();
const manifestSchema = z.object({
  kind: z.literal("MITRE_ATTACK_MANIFEST"),
  techniqueCount: z.number().int().nonnegative().max(MAX_TECHNIQUES),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  maxModifiedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const payloadSchema = z.discriminatedUnion("kind", [persistedPatternSchema, manifestSchema]);
const fetchedRecordSchema = z.object({ kind: z.enum(["ENTRY", "MANIFEST"]), payload: payloadSchema }).strict();
const checkpointSchema = z.object({
  version: z.literal(1),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  techniqueCount: z.number().int().nonnegative().max(MAX_TECHNIQUES).nullable(),
}).strict();

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function attackId(pattern: AttackPattern): string | null {
  const reference = pattern.external_references.find((item) => item.source_name === "mitre-attack" && item.external_id);
  return reference?.external_id ?? null;
}

function snapshotFingerprint(patterns: readonly AttackPattern[]): string {
  const rows = patterns.map((pattern) => `${pattern.id}:${sha256(canonicalJsonStringify(pattern))}`).sort();
  return sha256(rows.join("\n"));
}

export function normalizeMitreAttackPattern(input: unknown): CanonicalEvidenceDraft[] {
  const payload = payloadSchema.parse(input);
  if (payload.kind === "MITRE_ATTACK_MANIFEST") return [];
  const source = payload.source;
  const externalId = attackId(source);
  const entityKey = externalId ?? source.id;
  const references = source.external_references.map((item) => item.url).filter((value): value is string => Boolean(value)).slice(0, 100);
  return [{
    recordKind: "CONTEXT_KNOWLEDGE",
    canonicalKey: `context:mitre-attack-enterprise:${source.id}`,
    entities: [{ kind: "ATTACK_TECHNIQUE", key: entityKey, label: externalId ? `${externalId} — ${source.name}` : source.name }],
    facts: [
      { predicate: "mitre_attack.stix_id", value: source.id },
      { predicate: "mitre_attack.external_id", value: externalId },
      { predicate: "mitre_attack.name", value: source.name },
      { predicate: "mitre_attack.description", value: source.description ?? null },
      { predicate: "mitre_attack.created_at", value: source.created },
      { predicate: "mitre_attack.modified_at", value: source.modified },
      { predicate: "mitre_attack.version", value: source.x_mitre_version ?? null },
      { predicate: "mitre_attack.revoked", value: source.revoked ?? false },
      { predicate: "mitre_attack.deprecated", value: source.x_mitre_deprecated ?? false },
      { predicate: "mitre_attack.is_subtechnique", value: source.x_mitre_is_subtechnique ?? false },
      { predicate: "mitre_attack.platforms", value: source.x_mitre_platforms ?? [] },
      { predicate: "mitre_attack.tactics", value: (source.kill_chain_phases ?? []).map((phase) => phase.phase_name) },
    ],
    references: [...new Set([PUBLIC_REFERENCE, ...references])].slice(0, 100),
  }];
}

export function createMitreAttackEnterpriseAdapter(options: { fetchImpl?: typeof fetch } = {}): SourceAdapter {
  return {
    definition: {
      sourceKey: "MITRE_ATTACK_ENTERPRISE",
      displayName: "MITRE ATT&CK Enterprise Techniques",
      providerName: "MITRE",
      upstreamOriginKey: "MITRE_ATTACK",
      sourceClass: "CONTEXT_KNOWLEDGE",
      observationBasis: "PUBLISHED",
      authorityType: "AUTHORITATIVE_KNOWLEDGE_BASE",
      collectionMode: "SNAPSHOT",
      defaultPollIntervalSeconds: 86400,
      minimumPollIntervalSeconds: 3600,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "SNAPSHOT_RECONSTRUCTION",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      authRequirement: "NONE",
      credentialKind: null,
      adapterVersion: "mitre-attack-enterprise-adapter-v1",
      semanticContractVersion: "mitre-attack-enterprise-semantics-v1",
      licenseClass: "MITRE_ATTACK_TERMS",
      commercialUseStatus: "ALLOWED",
      redistributionStatus: "RESTRICTED",
      attributionRequirement: "Preserve MITRE ATT&CK attribution and comply with MITRE ATT&CK terms of use; do not imply MITRE endorsement.",
      termsReference: TERMS_REFERENCE,
      semanticBoundary: {
        represents: "Published MITRE ATT&CK Enterprise technique and sub-technique knowledge from official STIX data.",
        doesNotRepresent: "Observed global technique usage, event frequency, campaign confirmation, attribution conclusions, organization compromise, or threat-level measurement.",
      },
      enabledByDefault: false,
    },
    maxRecordsPerWorkUnit: MAX_TECHNIQUES,
    maxRawRecordBytes: 1024 * 1024,
    normalizationVersion: "mitre-attack-enterprise-normalization-v1",
    checkpointSchemaVersion: "mitre-attack-enterprise-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema: checkpointSchema,
    plan({ checkpoint }) {
      return checkpoint === null ? { version: 1, snapshotFingerprint: null, responseSha256: null, techniqueCount: null } : checkpointSchema.parse(checkpoint);
    },
    async fetch({ work, signal }) {
      const prior = checkpointSchema.parse(work);
      const response = await fetchBoundedJson({
        url: DATA_URL,
        allowedHost: DATA_URL.hostname,
        allowedPath: DATA_URL.pathname,
        maxBytes: MAX_RESPONSE_BYTES,
        timeoutMs: 30_000,
        signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      if (response.json === null) throw new CollectionFailure("PROVIDER_ERROR", "MITRE ATT&CK STIX data returned an empty body", true);
      const bundle = bundleSchema.parse(response.json);
      const patterns = bundle.objects.flatMap((object) => {
        const parsed = attackPatternSchema.safeParse(object);
        return parsed.success ? [parsed.data] : [];
      });
      if (patterns.length > MAX_TECHNIQUES) throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", "MITRE ATT&CK technique count exceeds configured bound", false);
      const responseSha256 = sha256(response.bytes);
      const fingerprint = snapshotFingerprint(patterns);
      const nextCheckpoint = { version: 1 as const, snapshotFingerprint: fingerprint, responseSha256, techniqueCount: patterns.length };
      if (prior.snapshotFingerprint === fingerprint) return { records: [], nextWork: null, nextCheckpoint, complete: true };
      const modified = patterns.map((pattern) => pattern.modified).sort();
      const manifest = manifestSchema.parse({ kind: "MITRE_ATTACK_MANIFEST", techniqueCount: patterns.length, responseSha256, snapshotFingerprint: fingerprint, maxModifiedAt: modified.at(-1) ?? null });
      return {
        records: [
          ...patterns.map((source) => ({ kind: "ENTRY" as const, payload: { kind: "MITRE_ATTACK_PATTERN" as const, source } })),
          { kind: "MANIFEST" as const, payload: manifest },
        ],
        nextWork: null,
        nextCheckpoint,
        complete: true,
      };
    },
    identifyRawRecord(record) {
      const parsed = fetchedRecordSchema.parse(record);
      return parsed.kind === "MANIFEST" ? "__enterprise_technique_manifest__" : (parsed.payload.kind === "MITRE_ATTACK_PATTERN" ? parsed.payload.source.id : "__invalid__");
    },
    extractTimes(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST") return { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null };
      if (parsed.payload.kind !== "MITRE_ATTACK_PATTERN") throw new CollectionFailure("SCHEMA_ERROR", "MITRE ATT&CK record kind mismatch", false);
      return { publishedAt: parsed.payload.source.created, effectiveAt: parsed.payload.source.created, upstreamUpdatedAt: parsed.payload.source.modified };
    },
    sourceReference(record) {
      const parsed = fetchedRecordSchema.parse(record);
      if (parsed.kind === "MANIFEST" || parsed.payload.kind !== "MITRE_ATTACK_PATTERN") return PUBLIC_REFERENCE;
      const url = parsed.payload.source.external_references.find((item) => item.source_name === "mitre-attack" && item.url)?.url;
      return url ?? PUBLIC_REFERENCE;
    },
    sourceSchemaVersion() { return "mitre-attack-enterprise-stix-v1"; },
    rawPayload(record) { return fetchedRecordSchema.parse(record).payload; },
    normalize(record) { return normalizeMitreAttackPattern(record); },
    classifyFailure(error) {
      if (error instanceof z.ZodError) return { code: "SCHEMA_ERROR", retryable: false, message: "MITRE ATT&CK STIX data failed schema validation" };
      return classifyUnknownFailure(error);
    },
  };
}

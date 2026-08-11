import { z } from "zod";
import type { CanonicalEvidenceDraft } from "./canonical.js";
import { observationBasisSchema, semanticBoundarySchema, sourceClassSchema } from "./semantics.js";

export const collectionModeSchema = z.enum(["POLL", "PAGED_POLL", "SNAPSHOT", "STREAM"]);
export const recoveryStrategySchema = z.enum([
  "HISTORICAL_QUERY",
  "CURSOR_CATCHUP",
  "SNAPSHOT_RECONSTRUCTION",
  "LIVE_ONLY",
]);
export const authRequirementSchema = z.enum(["NONE", "OPTIONAL", "REQUIRED"]);

export const sourceDefinitionSchema = z.object({
  sourceKey: z.string().regex(/^[A-Z0-9_]+$/).max(128),
  displayName: z.string().min(1).max(256),
  providerName: z.string().min(1).max(256),
  upstreamOriginKey: z.string().min(1).max(128),
  sourceClass: sourceClassSchema,
  observationBasis: observationBasisSchema,
  authorityType: z.string().min(1).max(128),
  collectionMode: collectionModeSchema,
  defaultPollIntervalSeconds: z.number().int().positive().nullable(),
  minimumPollIntervalSeconds: z.number().int().positive().nullable(),
  supportsHistoricalRetrieval: z.boolean(),
  recoveryStrategy: recoveryStrategySchema,
  historicalMaxWindowSeconds: z.number().int().positive().nullable(),
  // Legacy compatibility remains until all admitted adapters have moved to authRequirement.
  requiresAuth: z.boolean(),
  authRequirement: authRequirementSchema.optional(),
  credentialKind: z.string().min(1).max(128).nullable(),
  adapterVersion: z.string().min(1).max(128),
  semanticContractVersion: z.string().min(1).max(128),
  licenseClass: z.string().min(1).max(128),
  commercialUseStatus: z.enum(["UNKNOWN","ALLOWED","RESTRICTED","PROHIBITED","NOT_APPLICABLE"]),
  redistributionStatus: z.enum(["UNKNOWN","ALLOWED","RESTRICTED","PROHIBITED","NOT_APPLICABLE"]),
  attributionRequirement: z.string().max(2_000).nullable(),
  termsReference: z.string().url().nullable(),
  semanticBoundary: semanticBoundarySchema,
  enabledByDefault: z.boolean(),
});
export type SourceDefinition = z.infer<typeof sourceDefinitionSchema>;

export const sourceTimesSchema = z.object({
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  effectiveAt: z.string().datetime({ offset: true }).nullable(),
  upstreamUpdatedAt: z.string().datetime({ offset: true }).nullable(),
});
export type SourceTimes = z.infer<typeof sourceTimesSchema>;

export const collectionFailureCodeSchema = z.enum([
  "TRANSPORT_ERROR",
  "TIMEOUT",
  "RATE_LIMITED",
  "AUTHENTICATION_ERROR",
  "PROVIDER_ERROR",
  "SCHEMA_ERROR",
  "PAYLOAD_LIMIT_EXCEEDED",
  "SOURCE_SNAPSHOT_CHANGED",
  "INTERNAL_ERROR",
]);
export type CollectionFailureCode = z.infer<typeof collectionFailureCodeSchema>;

export interface ClassifiedFailure {
  code: CollectionFailureCode;
  retryable: boolean;
  message: string;
  retryAfterSeconds?: number;
}

export interface FetchResult {
  records: readonly unknown[];
  nextWork: unknown | null;
  nextCheckpoint: unknown;
  complete: boolean;
}

export interface SourceAdapter {
  readonly definition: SourceDefinition;
  /** Source-specific bounded result size for one work unit. Runtime hard caps still apply. */
  readonly maxRecordsPerWorkUnit?: number;
  /** Source-specific raw JSON record bound. Runtime global hard caps still apply. */
  readonly maxRawRecordBytes?: number;
  readonly normalizationVersion: string;
  readonly checkpointSchemaVersion: string;
  readonly checkpointSchema: z.ZodType<unknown>;
  readonly workDescriptorSchema: z.ZodType<unknown>;
  plan(input: { checkpoint: unknown | null }): Promise<unknown> | unknown;
  fetch(input: { work: unknown; signal: AbortSignal }): Promise<FetchResult>;
  identifyRawRecord(record: unknown): string;
  extractTimes(record: unknown): SourceTimes;
  sourceReference(record: unknown): string | null;
  sourceSchemaVersion(record: unknown): string | null;
  rawPayload(record: unknown): unknown;
  normalize(record: unknown): readonly CanonicalEvidenceDraft[];
  classifyFailure(error: unknown): ClassifiedFailure;
}

export function assertAdapterContract(adapter: SourceAdapter): void {
  const definition = sourceDefinitionSchema.parse(adapter.definition);
  if (definition.authRequirement === "REQUIRED" && !definition.requiresAuth) {
    throw new Error("authRequirement REQUIRED must keep legacy requiresAuth=true during compatibility period");
  }
  if (definition.authRequirement === "NONE" && definition.requiresAuth) {
    throw new Error("authRequirement NONE is incompatible with legacy requiresAuth=true");
  }
  if (adapter.maxRecordsPerWorkUnit !== undefined) {
    if (!Number.isInteger(adapter.maxRecordsPerWorkUnit) || adapter.maxRecordsPerWorkUnit < 1 || adapter.maxRecordsPerWorkUnit > 10_000) {
      throw new Error("maxRecordsPerWorkUnit must be an integer between 1 and 10000");
    }
  }
  if (adapter.maxRawRecordBytes !== undefined) {
    if (!Number.isInteger(adapter.maxRawRecordBytes) || adapter.maxRawRecordBytes < 1_024 || adapter.maxRawRecordBytes > 64 * 1024 * 1024) {
      throw new Error("maxRawRecordBytes must be an integer between 1 KiB and 64 MiB");
    }
  }
  if (!adapter.normalizationVersion.trim()) throw new Error("normalizationVersion is required");
  if (!adapter.checkpointSchemaVersion.trim()) throw new Error("checkpointSchemaVersion is required");
}

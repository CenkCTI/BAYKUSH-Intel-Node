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
  requiresAuth: z.boolean(),
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
  sourceDefinitionSchema.parse(adapter.definition);
  if (!adapter.normalizationVersion.trim()) throw new Error("normalizationVersion is required");
  if (!adapter.checkpointSchemaVersion.trim()) throw new Error("checkpointSchemaVersion is required");
}

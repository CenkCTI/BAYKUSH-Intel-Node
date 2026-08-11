import { z } from "zod";
import type { SourceAdapter } from "../contracts/source.js";
import { classifyUnknownFailure } from "../runtime/failure.js";

const checkpointSchema = z.object({ nextSequence: z.number().int().nonnegative() });
const workDescriptorSchema = z.object({
  runStart: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
const recordSchema = z.object({
  sequence: z.number().int().nonnegative(),
  value: z.string(),
  schemaVersion: z.literal("1"),
  effectiveAt: z.string().datetime({ offset: true }),
});

export function createTestSyntheticAdapter(options: { recordsPerRun: number; pageSize: number }): SourceAdapter {
  if (!Number.isInteger(options.recordsPerRun) || options.recordsPerRun <= 0) throw new Error("recordsPerRun must be positive");
  if (!Number.isInteger(options.pageSize) || options.pageSize <= 0) throw new Error("pageSize must be positive");

  return {
    definition: {
      sourceKey: "TEST_SYNTHETIC",
      displayName: "Deterministic Test Source",
      providerName: "BAYKUSH",
      upstreamOriginKey: "BAYKUSH_TEST",
      sourceClass: "UNKNOWN",
      observationBasis: "UNKNOWN",
      authorityType: "internal-test",
      collectionMode: "PAGED_POLL",
      defaultPollIntervalSeconds: 60,
      minimumPollIntervalSeconds: null,
      supportsHistoricalRetrieval: false,
      recoveryStrategy: "LIVE_ONLY",
      historicalMaxWindowSeconds: null,
      requiresAuth: false,
      credentialKind: null,
      adapterVersion: "node-1-test-v1",
      semanticContractVersion: "node-1-sem-v1",
      licenseClass: "INTERNAL_TEST",
      commercialUseStatus: "NOT_APPLICABLE",
      redistributionStatus: "NOT_APPLICABLE",
      attributionRequirement: null,
      termsReference: null,
      semanticBoundary: {
        represents: "Deterministic synthetic records used to test BAYKUSH Node collection mechanics.",
        doesNotRepresent: "Real cyber activity, external observations, attacks, victims, malware prevalence, or threat level.",
      },
      enabledByDefault: false,
    },
    normalizationVersion: "node-2a-test-normalization-v1",
    checkpointSchemaVersion: "test-synthetic-checkpoint-v1",
    checkpointSchema,
    workDescriptorSchema,
    plan({ checkpoint }) {
      const parsedCheckpoint = checkpoint === null ? { nextSequence: 0 } : checkpointSchema.parse(checkpoint);
      return {
        runStart: parsedCheckpoint.nextSequence,
        offset: 0,
        total: options.recordsPerRun,
        pageSize: options.pageSize,
      };
    },
    async fetch({ work, signal }) {
      if (signal.aborted) throw new DOMException("Synthetic fetch aborted", "AbortError");
      const descriptor = workDescriptorSchema.parse(work);
      const remaining = descriptor.total - descriptor.offset;
      const count = Math.min(descriptor.pageSize, remaining);
      const records = Array.from({ length: count }, (_, index) => {
        const sequence = descriptor.runStart + descriptor.offset + index;
        return {
          sequence,
          value: `synthetic-${sequence}`,
          schemaVersion: "1" as const,
          effectiveAt: new Date(Date.UTC(2026, 0, 1, 0, sequence)).toISOString(),
        };
      });
      const nextOffset = descriptor.offset + count;
      return {
        records,
        nextWork: nextOffset < descriptor.total
          ? { ...descriptor, offset: nextOffset }
          : null,
        nextCheckpoint: { nextSequence: descriptor.runStart + nextOffset },
        complete: nextOffset >= descriptor.total,
      };
    },
    identifyRawRecord(record) {
      const parsed = recordSchema.parse(record);
      return `synthetic:${parsed.sequence}`;
    },
    extractTimes(record) {
      const parsed = recordSchema.parse(record);
      return { publishedAt: null, effectiveAt: parsed.effectiveAt, upstreamUpdatedAt: null };
    },
    sourceReference() {
      return null;
    },
    sourceSchemaVersion(record) {
      return recordSchema.parse(record).schemaVersion;
    },
    rawPayload(record) {
      return recordSchema.parse(record);
    },
    normalize(record) {
      const parsed = recordSchema.parse(record);
      return [{
        recordKind: "UNKNOWN",
        canonicalKey: `test:synthetic:${parsed.sequence}`,
        entities: [],
        facts: [{ predicate: "test.sequence", value: parsed.sequence }],
        references: [],
      }];
    },
    classifyFailure(error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return { code: "TIMEOUT", retryable: true, message: "Synthetic work unit timed out" };
      }
      return classifyUnknownFailure(error);
    },
  };
}

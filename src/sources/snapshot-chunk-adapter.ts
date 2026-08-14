import { createHash } from "node:crypto";
import { z } from "zod";
import type { SourceAdapter } from "../contracts/source.js";
import { CollectionFailure } from "../runtime/failure.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

const wrapperWorkSchema = z.object({
  version: z.literal(1),
  baseWork: z.unknown(),
  previousCheckpoint: z.unknown(),
  expectedCheckpointHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  chunkIndex: z.number().int().nonnegative().max(10_000),
}).strict();

type WrapperWork = z.infer<typeof wrapperWorkSchema>;

function hashCheckpoint(checkpoint: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(checkpoint)).digest("hex");
}

export function withReplayableSnapshotChunking(base: SourceAdapter, maxRecordsPerWorkUnit = 10_000): SourceAdapter {
  if (!Number.isInteger(maxRecordsPerWorkUnit) || maxRecordsPerWorkUnit < 1 || maxRecordsPerWorkUnit > 10_000) {
    throw new Error("snapshot chunk bound must be an integer between 1 and 10000");
  }

  return {
    ...base,
    maxRecordsPerWorkUnit,
    workDescriptorSchema: wrapperWorkSchema,
    async plan({ checkpoint }) {
      const baseWork = await base.plan({ checkpoint });
      const previousCheckpoint = checkpoint === null
        ? base.checkpointSchema.parse(baseWork)
        : base.checkpointSchema.parse(checkpoint);
      return {
        version: 1,
        baseWork,
        previousCheckpoint,
        expectedCheckpointHash: null,
        chunkIndex: 0,
      } satisfies WrapperWork;
    },
    async fetch({ work, signal }) {
      const descriptor = wrapperWorkSchema.parse(work);
      const baseResult = await base.fetch({ work: descriptor.baseWork, signal });
      if (!baseResult.complete || baseResult.nextWork !== null) {
        throw new CollectionFailure("INTERNAL_ERROR", "Replayable snapshot chunking requires a one-shot complete base adapter", false);
      }

      const parsedCheckpoint = base.checkpointSchema.parse(baseResult.nextCheckpoint);
      const checkpointHash = hashCheckpoint(parsedCheckpoint);
      if (descriptor.expectedCheckpointHash && descriptor.expectedCheckpointHash !== checkpointHash) {
        throw new CollectionFailure("SOURCE_SNAPSHOT_CHANGED", "Source snapshot changed between bounded replay chunks", true);
      }

      if (baseResult.records.length <= maxRecordsPerWorkUnit && descriptor.chunkIndex === 0) {
        return { records: baseResult.records, nextWork: null, nextCheckpoint: parsedCheckpoint, complete: true };
      }

      const chunkCount = Math.max(1, Math.ceil(baseResult.records.length / maxRecordsPerWorkUnit));
      if (descriptor.chunkIndex >= chunkCount) {
        throw new CollectionFailure("INTERNAL_ERROR", "Snapshot replay chunk index exceeds current snapshot bounds", false);
      }
      const start = descriptor.chunkIndex * maxRecordsPerWorkUnit;
      const records = baseResult.records.slice(start, start + maxRecordsPerWorkUnit);
      const finalChunk = descriptor.chunkIndex === chunkCount - 1;
      if (finalChunk) {
        return { records, nextWork: null, nextCheckpoint: parsedCheckpoint, complete: true };
      }

      const nextWork: WrapperWork = {
        version: 1,
        baseWork: descriptor.baseWork,
        previousCheckpoint: descriptor.previousCheckpoint,
        expectedCheckpointHash: checkpointHash,
        chunkIndex: descriptor.chunkIndex + 1,
      };
      return {
        records,
        nextWork,
        nextCheckpoint: base.checkpointSchema.parse(descriptor.previousCheckpoint),
        complete: false,
      };
    },
  };
}

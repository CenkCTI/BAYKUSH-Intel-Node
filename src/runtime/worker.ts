import { config } from "../config.js";
import { adapterRegistry } from "../sources/registry.js";
import { CollectionFailure, classifyUnknownFailure } from "./failure.js";
import { prepareRawRecord } from "./raw-record.js";
import {
  claimNextRun,
  claimNextWorkUnit,
  ensureWorkUnit,
  failClaimedRun,
  loadCheckpoint,
  persistWorkFailure,
  persistWorkSuccess,
  recordSourceAttempt,
} from "./repository.js";

export async function workerTick(workerId = config.instanceId): Promise<boolean> {
  const run = await claimNextRun(workerId, config.workerLeaseSeconds);
  if (!run) return false;

  const adapter = adapterRegistry.get(run.sourceKey);
  if (!adapter) {
    await failClaimedRun(run, workerId, {
      code: "INTERNAL_ERROR",
      retryable: false,
      message: `No registered adapter for ${run.sourceKey}`,
    });
    return true;
  }

  try {
    const storedCheckpoint = await loadCheckpoint(run.sourceDefinitionId);
    if (storedCheckpoint && storedCheckpoint.schemaVersion !== adapter.checkpointSchemaVersion) {
      throw new CollectionFailure("SCHEMA_ERROR", "Stored checkpoint schema version is incompatible with adapter", false);
    }
    const checkpoint = storedCheckpoint ? adapter.checkpointSchema.parse(storedCheckpoint.checkpoint) : null;
    const initialWork = adapter.workDescriptorSchema.parse(await adapter.plan({ checkpoint }));
    await ensureWorkUnit(run.id, initialWork);
  } catch (error) {
    const failure = error instanceof CollectionFailure ? classifyUnknownFailure(error) : adapter.classifyFailure(error);
    await failClaimedRun(run, workerId, failure);
    return true;
  }

  const work = await claimNextWorkUnit(run.id, workerId, config.workerLeaseSeconds);
  if (!work) {
    await failClaimedRun(run, workerId, {
      code: "INTERNAL_ERROR",
      retryable: false,
      message: "Claimed run had no claimable work unit",
    });
    return true;
  }

  await recordSourceAttempt(run.sourceDefinitionId);
  const controller = new AbortController();
  const timeoutMs = Math.max(1_000, (config.workerLeaseSeconds - 5) * 1_000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const descriptor = adapter.workDescriptorSchema.parse(work.descriptor);
    const result = await adapter.fetch({ work: descriptor, signal: controller.signal });
    const sourceBound = adapter.maxRecordsPerWorkUnit ?? config.maxRecordsPerWorkUnit;
    const effectiveBound = Math.min(sourceBound, config.globalMaxRecordsPerWorkUnit);
    if (result.records.length > effectiveBound) {
      throw new CollectionFailure(
        "PAYLOAD_LIMIT_EXCEEDED",
        `Work unit returned ${result.records.length} records; effective source limit is ${effectiveBound}`,
        false,
      );
    }
    if (result.complete && result.nextWork !== null) {
      throw new CollectionFailure("SCHEMA_ERROR", "Completed work cannot provide nextWork", false);
    }
    if (!result.complete && result.nextWork === null) {
      throw new CollectionFailure("SCHEMA_ERROR", "Incomplete work must provide nextWork", false);
    }

    const nextCheckpoint = adapter.checkpointSchema.parse(result.nextCheckpoint);
    const nextWork = result.nextWork === null ? null : adapter.workDescriptorSchema.parse(result.nextWork);
    const sourceRawBound = adapter.maxRawRecordBytes ?? config.maxRawRecordBytes;
    const effectiveRawBound = Math.min(sourceRawBound, config.globalMaxRawRecordBytes);
    const records = result.records.map((record) => {
      const times = adapter.extractTimes(record);
      return prepareRawRecord({
        sourceRecordId: adapter.identifyRawRecord(record),
        payload: adapter.rawPayload(record),
        publishedAt: times.publishedAt,
        effectiveAt: times.effectiveAt,
        upstreamUpdatedAt: times.upstreamUpdatedAt,
        sourceUrl: adapter.sourceReference(record),
        sourceSchemaVersion: adapter.sourceSchemaVersion(record),
      }, effectiveRawBound);
    });

    await persistWorkSuccess({
      run,
      work,
      workerId,
      adapter,
      records,
      nextCheckpoint,
      nextWork,
      complete: result.complete,
    });
  } catch (error) {
    let failure;
    if (controller.signal.aborted) {
      failure = { code: "TIMEOUT" as const, retryable: true, message: "Collection work unit exceeded its lease-safe timeout" };
    } else if (error instanceof CollectionFailure) {
      failure = classifyUnknownFailure(error);
    } else {
      failure = adapter.classifyFailure(error);
    }
    await persistWorkFailure({
      run,
      work,
      workerId,
      failure,
      maxAttempts: config.workerMaxAttempts,
      retryBaseSeconds: config.workerRetryBaseSeconds,
      retryMaxSeconds: config.workerRetryMaxSeconds,
    });
  } finally {
    clearTimeout(timeout);
  }

  return true;
}

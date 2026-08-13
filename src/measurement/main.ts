import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { aggregationTick } from "./aggregation/engine.js";
import { measurementConfig } from "./config.js";
import {
  coverageAggregationTick,
  discoverCoverageBuckets,
  discoverCoverageJobs,
  reconcileCoverageJobTick,
} from "./coverage/runtime.js";
import { syncNoveltyFacts } from "./entities/novelty.js";
import {
  discoverProjectionJobs,
  projectionTick,
} from "./projection/runtime.js";
import { syncMeasurementRegistry } from "./registry.js";

let stopping = false;
const stopHeartbeat = startHeartbeatLoop("MEASUREMENT", {
  subsystem: "historical-measurement",
  schemaVersion: "NODE3_RUNTIME_V1",
});
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function drainTicks(
  limit: number,
  tick: () => Promise<boolean>,
): Promise<number> {
  let processed = 0;
  for (let index = 0; index < limit && !stopping; index += 1) {
    if (!(await tick())) break;
    processed += 1;
  }
  return processed;
}

async function measurementLoop(): Promise<void> {
  await syncMeasurementRegistry();

  while (!stopping) {
    if (!measurementConfig.enabled) {
      await sleep(measurementConfig.tickMs);
      continue;
    }

    try {
      const discoveredCoverageJobs = await discoverCoverageJobs(measurementConfig.discoveryBatch);
      const discoveredProjectionJobs = await discoverProjectionJobs(measurementConfig.discoveryBatch);
      const discoveredCoverageBuckets = await discoverCoverageBuckets(
        new Date(),
        measurementConfig.discoveryBatch,
      );

      const reconciledRuns = await drainTicks(
        measurementConfig.coverageBatch,
        () => reconcileCoverageJobTick(config.instanceId),
      );
      const projected = await drainTicks(
        measurementConfig.projectionBatch,
        () => projectionTick(config.instanceId),
      );
      const novelty = await syncNoveltyFacts(measurementConfig.noveltyBatch);
      const coverageBuckets = await drainTicks(
        measurementConfig.coverageBatch,
        () => coverageAggregationTick(config.instanceId),
      );
      const aggregates = await drainTicks(
        measurementConfig.aggregationBatch,
        () => aggregationTick(config.instanceId),
      );

      const didWork =
        discoveredCoverageJobs
        + discoveredProjectionJobs
        + discoveredCoverageBuckets
        + reconciledRuns
        + projected
        + novelty
        + coverageBuckets
        + aggregates;

      if (didWork === 0) await sleep(measurementConfig.tickMs);
    } catch (error) {
      console.error("measurement tick failed", error);
      await sleep(measurementConfig.tickMs);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`measurement received ${signal}; shutting down`);
  stopping = true;
  stopHeartbeat();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await measurementLoop();

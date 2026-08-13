import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "./heartbeat.js";
import { adapterRegistry } from "../sources/node5-runtime-registry.js";
import { enqueueDueRuns, setSourceEnabled } from "./repository.js";
import { syncSourceDefinitions } from "./source-sync.js";

let sourceDefinitionsSynchronized = false;
let developmentSourceConfigured = false;

export async function node5SchedulerTick(): Promise<number> {
  if (!sourceDefinitionsSynchronized) {
    await syncSourceDefinitions([...adapterRegistry.values()]);
    sourceDefinitionsSynchronized = true;
  }
  if (config.enableTestSynthetic && !developmentSourceConfigured) {
    await setSourceEnabled("TEST_SYNTHETIC", true);
    developmentSourceConfigured = true;
  }
  return enqueueDueRuns([...adapterRegistry.keys()], 10);
}

export async function startNode5Scheduler(): Promise<void> {
  let stopping = false;
  const stopHeartbeat = startHeartbeatLoop("SCHEDULER");
  const stop = () => {
    stopping = true;
    stopHeartbeat();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  try {
    while (!stopping) {
      try {
        const enqueued = await node5SchedulerTick();
        if (enqueued) console.log(`scheduler enqueued ${enqueued} run(s)`);
      } catch (error) {
        console.error("scheduler tick failed", error);
      }
      await new Promise((resolve) => setTimeout(resolve, config.schedulerTickMs));
    }
  } finally {
    await pool.end();
  }
}

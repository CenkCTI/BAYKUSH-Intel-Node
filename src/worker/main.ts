import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { workerTick } from "../runtime/worker.js";

let stopping = false;
const stopHeartbeat = startHeartbeatLoop("WORKER");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  while (!stopping) {
    try {
      const didWork = await workerTick();
      if (!didWork) await sleep(config.workerIdleMs);
    } catch (error) {
      console.error("worker tick failed", error);
      await sleep(config.workerIdleMs);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`worker received ${signal}; shutting down`);
  stopping = true;
  stopHeartbeat();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await main();

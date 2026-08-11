import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { schedulerTick } from "../runtime/scheduler.js";

let stopping = false;
const stopHeartbeat = startHeartbeatLoop("SCHEDULER");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  while (!stopping) {
    try {
      const enqueued = await schedulerTick();
      if (enqueued) console.log(`scheduler enqueued ${enqueued} run(s)`);
    } catch (error) {
      console.error("scheduler tick failed", error);
    }
    await sleep(config.schedulerTickMs);
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`scheduler received ${signal}; shutting down`);
  stopping = true;
  stopHeartbeat();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await main();

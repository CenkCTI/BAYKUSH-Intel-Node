import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { normalizerTick } from "../runtime/normalization.js";

let stopping = false;
const stopHeartbeat = startHeartbeatLoop("NORMALIZER");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  while (!stopping) {
    try {
      const didWork = await normalizerTick();
      if (!didWork) await sleep(config.normalizerIdleMs);
    } catch (error) {
      console.error("normalizer tick failed", error);
      await sleep(config.normalizerIdleMs);
    }
  }
}

async function shutdown(signal: string): Promise<void> {
  console.log(`normalizer received ${signal}; shutting down`);
  stopping = true;
  stopHeartbeat();
  await pool.end();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await main();

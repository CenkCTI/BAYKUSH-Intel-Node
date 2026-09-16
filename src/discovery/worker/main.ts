import { randomUUID } from "node:crypto";
import { startHeartbeatLoop } from "../../runtime/heartbeat.js";
import { processNode7ActivityBatch } from "../activity.js";
import { processNode7ConvergenceBatch } from "../convergence.js";
import { processNode7DiscoveryBatch } from "../discovery.js";
import { processNode7GeographyBatch } from "../geography/runtime.js";

const workerId = `node7-discovery-${process.pid}-${randomUUID()}`;
const idleDelayMs = 2_000;
const activeDelayMs = 250;
const stopHeartbeat = startHeartbeatLoop("DISCOVERY_WORKER", { workerId });

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  while (true) {
    const activity = await processNode7ActivityBatch({ workerId, queueLimit: 500, processLimit: 100 });
    const convergence = await processNode7ConvergenceBatch({ workerId, queueLimit: 500, processLimit: 100 });
    const discovery = await processNode7DiscoveryBatch({ workerId, queueLimit: 500, processLimit: 100 });
    const geography = await processNode7GeographyBatch({ workerId, queueLimit: 250, processLimit: 25 });
    const active = activity.queued > 0 || activity.processed > 0
      || convergence.queued > 0 || convergence.processed > 0
      || discovery.queued > 0 || discovery.processed > 0
      || geography.queued > 0 || geography.processed > 0;
    await sleep(active ? activeDelayMs : idleDelayMs);
  }
}

function shutdown(): void {
  stopHeartbeat();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

main().catch((error) => {
  stopHeartbeat();
  console.error("NODE-7 discovery worker failed", error);
  process.exitCode = 1;
});

import { randomUUID } from "node:crypto";
import { processNode7ActivityBatch } from "../activity.js";
import { processNode7ConvergenceBatch } from "../convergence.js";

const workerId = `node7-discovery-${process.pid}-${randomUUID()}`;
const idleDelayMs = 2_000;
const activeDelayMs = 250;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  while (true) {
    const activity = await processNode7ActivityBatch({
      workerId,
      queueLimit: 500,
      processLimit: 100,
    });
    const convergence = await processNode7ConvergenceBatch({
      workerId,
      queueLimit: 500,
      processLimit: 100,
    });
    const active = activity.queued > 0 || activity.processed > 0
      || convergence.queued > 0 || convergence.processed > 0;
    await sleep(active ? activeDelayMs : idleDelayMs);
  }
}

main().catch((error) => {
  console.error("NODE-7 discovery worker failed", error);
  process.exitCode = 1;
});

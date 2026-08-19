import { randomUUID } from "node:crypto";
import { processNode7ActivityBatch } from "../activity.js";

const workerId = `node7-discovery-${process.pid}-${randomUUID()}`;
const idleDelayMs = 2_000;
const activeDelayMs = 250;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  while (true) {
    const result = await processNode7ActivityBatch({
      workerId,
      queueLimit: 500,
      processLimit: 100,
    });
    await sleep(result.queued > 0 || result.processed > 0 ? activeDelayMs : idleDelayMs);
  }
}

main().catch((error) => {
  console.error("NODE-7 discovery worker failed", error);
  process.exitCode = 1;
});

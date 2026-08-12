import { pool } from "../db/pool.js";
import { exportNodeParitySnapshot } from "../node2g/node-projection.js";
import {
  compareParitySnapshots,
  productionSourceKeySchema,
  type ManualParityClassification,
} from "../node2g/parity.js";
import { collectNode2Readiness } from "../node2g/readiness.js";

async function readStdinJson(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) throw new Error("NODE-2G parity requires JSON on stdin");
  return JSON.parse(text) as unknown;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "status") {
    const readiness = await collectNode2Readiness(pool);
    process.stdout.write(`${JSON.stringify(readiness, null, 2)}\n`);
    if (!readiness.automatedReady) process.exitCode = 1;
    return;
  }

  if (command === "export-node") {
    const sourceKey = productionSourceKeySchema.parse(process.argv[3]);
    const upstreamSnapshotId = process.argv[4]?.trim() || null;
    const snapshot = await exportNodeParitySnapshot(pool, sourceKey, { upstreamSnapshotId });
    process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
    return;
  }

  if (command === "parity") {
    const payload = object(await readStdinJson());
    const classifications = Array.isArray(payload.classifications)
      ? payload.classifications as ManualParityClassification[]
      : [];
    const result = compareParitySnapshots(payload.node, payload.citem, classifications);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.accepted) process.exitCode = 1;
    return;
  }

  throw new Error(
    "Usage: node dist/cli/node2g.js status | export-node <SOURCE_KEY> [upstreamSnapshotId] | parity < payload.json",
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}

import { pool } from "../src/db/pool.js";
import { exportNodeParitySnapshot } from "../src/node2g/node-projection.js";
import { productionSourceKeySchema } from "../src/node2g/parity.js";

const [, , rawSourceKey, upstreamSnapshotId] = process.argv;
if (!rawSourceKey) {
  console.error("Usage: npm run node2g:export-node -- <SOURCE_KEY> [upstream-snapshot-id]");
  process.exit(2);
}

try {
  const sourceKey = productionSourceKeySchema.parse(rawSourceKey);
  const snapshot = await exportNodeParitySnapshot(pool, sourceKey, {
    upstreamSnapshotId: upstreamSnapshotId ?? null,
  });
  console.log(JSON.stringify(snapshot, null, 2));
} finally {
  await pool.end();
}

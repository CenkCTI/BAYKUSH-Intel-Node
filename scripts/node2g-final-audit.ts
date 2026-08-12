import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { collectNode2FinalAudit } from "../src/node2g/final-audit.js";

async function main(): Promise<void> {
  const report = await collectNode2FinalAudit(pool);
  assert.equal(report.accepted, true, "NODE-2 final database invariant audit must pass");
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}

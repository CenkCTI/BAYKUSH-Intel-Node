import { pool } from "../src/db/pool.js";
import { collectNode2Readiness } from "../src/node2g/readiness.js";

try {
  const report = await collectNode2Readiness(pool);
  console.log("BAYKUSH NODE-2 AUTOMATED READINESS");
  console.log("");
  for (const source of report.sources) {
    const normalization = `${source.normalizationQueued}/${source.normalizationRunning}/${source.normalizationFailed}`;
    console.log(
      `${source.sourceKey.padEnd(14)} ${source.automatedReady ? "READY" : "NOT_READY"} ` +
      `health=${source.healthStatus ?? "MISSING"} success=${source.successfulRuns} ` +
      `raw=${source.rawRecords} canonical=${source.canonicalRecords} normalization=${normalization}`,
    );
  }
  console.log("");
  console.log(`canonical_without_raw=${report.canonicalWithoutRaw}`);
  console.log(`canonical_source_mismatches=${report.canonicalSourceMismatches}`);
  console.log(`duplicate_active_scheduled_runs=${report.duplicateActiveScheduledRuns}`);
  console.log(`NODE-2 automated readiness=${report.automatedReady ? "READY" : "NOT_READY"}`);
  console.log("Manual live shadow parity and collection-authority cutover remain operator gates.");
  process.exitCode = report.automatedReady ? 0 : 1;
} finally {
  await pool.end();
}

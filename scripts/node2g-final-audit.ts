import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { PRODUCTION_SOURCE_KEYS } from "../src/node2g/readiness.js";

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const result = await pool.query<{ count: number }>(sql, params);
  return result.rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const duplicateActiveRuns = await scalar(
    `SELECT count(*)::int AS count FROM (
       SELECT source_definition_id
         FROM collection_runs
        WHERE state IN ('QUEUED','RUNNING')
        GROUP BY source_definition_id HAVING count(*) > 1
     ) x`,
  );
  const duplicateRawRevisions = await scalar(
    `SELECT count(*)::int AS count FROM (
       SELECT source_definition_id, source_record_id, payload_sha256
         FROM raw_source_records
        GROUP BY 1,2,3 HAVING count(*) > 1
     ) x`,
  );
  const duplicateNormalizationJobs = await scalar(
    `SELECT count(*)::int AS count FROM (
       SELECT raw_record_id, normalization_version
         FROM normalization_jobs
        GROUP BY 1,2 HAVING count(*) > 1
     ) x`,
  );
  const duplicateCanonicalRecords = await scalar(
    `SELECT count(*)::int AS count FROM (
       SELECT raw_record_id, normalization_version, canonical_key, record_kind
         FROM canonical_evidence_records
        GROUP BY 1,2,3,4 HAVING count(*) > 1
     ) x`,
  );
  const canonicalWithoutRaw = await scalar(
    `SELECT count(*)::int AS count
       FROM canonical_evidence_records c
       LEFT JOIN raw_source_records r ON r.id = c.raw_record_id
      WHERE r.id IS NULL`,
  );
  const normalizationWithoutRaw = await scalar(
    `SELECT count(*)::int AS count
       FROM normalization_jobs j
       LEFT JOIN raw_source_records r ON r.id = j.raw_record_id
      WHERE r.id IS NULL`,
  );
  const canonicalSourceMismatch = await scalar(
    `SELECT count(*)::int AS count
       FROM canonical_evidence_records c
       JOIN raw_source_records r ON r.id = c.raw_record_id
      WHERE c.source_definition_id <> r.source_definition_id
         OR c.source_record_id <> r.source_record_id`,
  );
  const normalizationSourceMismatch = await scalar(
    `SELECT count(*)::int AS count
       FROM normalization_jobs j
       JOIN raw_source_records r ON r.id = j.raw_record_id
      WHERE j.source_definition_id <> r.source_definition_id`,
  );
  const productionNormalizationQueued = await scalar(
    `SELECT count(*)::int AS count
       FROM normalization_jobs j JOIN source_definitions d ON d.id = j.source_definition_id
      WHERE d.source_key = ANY($1::text[]) AND j.state = 'QUEUED'`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );
  const productionNormalizationRunning = await scalar(
    `SELECT count(*)::int AS count
       FROM normalization_jobs j JOIN source_definitions d ON d.id = j.source_definition_id
      WHERE d.source_key = ANY($1::text[]) AND j.state = 'RUNNING'`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );
  const productionNormalizationFailed = await scalar(
    `SELECT count(*)::int AS count
       FROM normalization_jobs j JOIN source_definitions d ON d.id = j.source_definition_id
      WHERE d.source_key = ANY($1::text[]) AND j.state = 'FAILED'`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );
  const badCheckpointLineage = await scalar(
    `SELECT count(*)::int AS count
       FROM source_checkpoints c
       JOIN source_definitions d ON d.id = c.source_definition_id
       LEFT JOIN collection_runs r ON r.id = c.updated_by_run_id
      WHERE d.source_key = ANY($1::text[])
        AND (r.id IS NULL OR r.source_definition_id <> c.source_definition_id)`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );

  const report = {
    duplicateActiveRuns,
    duplicateRawRevisions,
    duplicateNormalizationJobs,
    duplicateCanonicalRecords,
    canonicalWithoutRaw,
    normalizationWithoutRaw,
    canonicalSourceMismatch,
    normalizationSourceMismatch,
    productionNormalizationQueued,
    productionNormalizationRunning,
    productionNormalizationFailed,
    badCheckpointLineage,
  };

  for (const [name, value] of Object.entries(report)) {
    assert.equal(value, 0, `${name} must be zero at NODE-2 final acceptance`);
  }

  console.log(JSON.stringify({ schemaVersion: "NODE2G_FINAL_AUDIT_V1", accepted: true, ...report }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}

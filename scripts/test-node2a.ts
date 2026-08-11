import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { adapterRegistry } from "../src/sources/registry.js";

const sourceKey = "TEST_SYNTHETIC";

async function resetSource(): Promise<string> {
  await syncSourceDefinitions([...adapterRegistry.values()]);
  const source = await pool.query<{ id: string }>(
    "SELECT id FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId);
  await pool.query("DELETE FROM canonical_evidence_records WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM normalization_jobs WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM raw_source_records WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM source_checkpoints WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query(
    "DELETE FROM collection_work_units WHERE run_id IN (SELECT id FROM collection_runs WHERE source_definition_id = $1)",
    [sourceDefinitionId],
  );
  await pool.query("DELETE FROM collection_runs WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query(
    `UPDATE source_schedule_state
     SET next_due_at = now() - interval '1 second', last_enqueued_at = NULL, updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  await setSourceEnabled(sourceKey, true);
  return sourceDefinitionId;
}

async function latestRun(sourceDefinitionId: string) {
  const result = await pool.query<{ id: string; trigger: string; purpose: string; state: string }>(
    `SELECT id, trigger, purpose, state FROM collection_runs
     WHERE source_definition_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  assert.ok(row);
  return row;
}

async function main(): Promise<void> {
  const sourceDefinitionId = await resetSource();

  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  const bootstrap = await latestRun(sourceDefinitionId);
  assert.equal(bootstrap.trigger, "BOOTSTRAP");
  assert.equal(bootstrap.purpose, "INITIAL_BOOTSTRAP");

  for (let index = 0; index < 3; index += 1) {
    assert.equal(await workerTick(`node2a-collector-${index}`), true);
  }
  const completedBootstrap = await latestRun(sourceDefinitionId);
  assert.equal(completedBootstrap.state, "SUCCEEDED");

  const queued = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM normalization_jobs
     WHERE source_definition_id = $1 AND state = 'QUEUED'`,
    [sourceDefinitionId],
  );
  assert.equal(queued.rows[0]?.count, 25, "each inserted raw record must enqueue normalization exactly once");

  for (let index = 0; index < 25; index += 1) {
    assert.equal(await normalizerTick(`node2a-normalizer-${index}`), true);
  }
  assert.equal(await normalizerTick("node2a-normalizer-empty"), false);

  const canonicalCount = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  assert.equal(canonicalCount.rows[0]?.count, 25);

  const provenance = await pool.query<{
    canonical_key: string;
    source_record_id: string;
    represents: string;
    normalization_version: string;
  }>(
    `SELECT c.canonical_key, r.source_record_id,
            c.semantic_boundary->>'represents' AS represents,
            c.normalization_version
     FROM canonical_evidence_records c
     JOIN raw_source_records r ON r.id = c.raw_record_id
     WHERE c.source_definition_id = $1
     ORDER BY c.canonical_key
     LIMIT 1`,
    [sourceDefinitionId],
  );
  const sample = provenance.rows[0];
  assert.ok(sample);
  assert.match(sample.canonical_key, /^test:synthetic:/);
  assert.match(sample.source_record_id, /^synthetic:/);
  assert.equal(sample.represents, "Deterministic synthetic records used to test BAYKUSH Node collection mechanics.");
  assert.equal(sample.normalization_version, "node-2a-test-normalization-v1");

  await pool.query(
    `UPDATE source_schedule_state SET next_due_at = now() - interval '1 second', updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  const liveRun = await latestRun(sourceDefinitionId);
  assert.equal(liveRun.trigger, "SCHEDULED");
  assert.equal(liveRun.purpose, "LIVE_INCREMENTAL");

  await setSourceEnabled(sourceKey, false);
  await pool.query("DELETE FROM collection_runs WHERE id = $1", [liveRun.id]);
  console.log("NODE-2A production foundation acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

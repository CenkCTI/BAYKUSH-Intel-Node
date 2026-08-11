import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { adapterRegistry } from "../src/sources/registry.js";
import { workerTick } from "../src/runtime/worker.js";
import {
  claimNextRun,
  claimNextWorkUnit,
  enqueueDueRuns,
  ensureWorkUnit,
  loadCheckpoint,
  persistWorkFailure,
  setSourceEnabled,
} from "../src/runtime/repository.js";

const sourceKey = "TEST_SYNTHETIC";

async function resetAcceptanceState(): Promise<string> {
  const source = await pool.query<{ id: string }>(
    "SELECT id FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId, "TEST_SYNTHETIC source definition must exist");

  await pool.query("DELETE FROM raw_source_records WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM source_checkpoints WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query(
    "DELETE FROM collection_work_units WHERE run_id IN (SELECT id FROM collection_runs WHERE source_definition_id = $1)",
    [sourceDefinitionId],
  );
  await pool.query("DELETE FROM collection_runs WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query(
    `UPDATE source_schedule_state
     SET next_due_at = now(), last_enqueued_at = NULL, updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  await pool.query(
    `UPDATE source_health
     SET health_status = 'PAUSED', last_attempt_at = NULL, last_success_at = NULL,
         last_failure_at = NULL, consecutive_failures = 0,
         latest_failure_code = NULL, latest_failure_message = NULL, updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  await setSourceEnabled(sourceKey, true);
  return sourceDefinitionId;
}

async function forceDue(sourceDefinitionId: string): Promise<void> {
  await pool.query(
    "UPDATE source_schedule_state SET next_due_at = now() - interval '1 second', updated_at = now() WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
}

async function runSyntheticToCompletion(workerId: string): Promise<void> {
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await workerTick(workerId), true, `worker tick ${index + 1} should process one bounded unit`);
  }
}

async function latestRun(sourceDefinitionId: string) {
  const result = await pool.query<{
    id: string;
    state: string;
    work_units_succeeded: number;
    raw_records_accepted: string;
    raw_records_inserted: string;
  }>(
    `SELECT id, state, work_units_succeeded, raw_records_accepted::text, raw_records_inserted::text
     FROM collection_runs
     WHERE source_definition_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  assert.ok(row, "expected a collection run");
  return row;
}

async function main(): Promise<void> {
  const sourceDefinitionId = await resetAcceptanceState();

  assert.equal(await enqueueDueRuns([sourceKey], 1), 1, "scheduler should enqueue one due source");
  assert.equal(await enqueueDueRuns([sourceKey], 1), 0, "scheduler must not enqueue a second active run");
  await runSyntheticToCompletion("acceptance-worker-1");

  const firstRun = await latestRun(sourceDefinitionId);
  assert.equal(firstRun.state, "SUCCEEDED");
  assert.equal(firstRun.work_units_succeeded, 3);
  assert.equal(firstRun.raw_records_accepted, "25");
  assert.equal(firstRun.raw_records_inserted, "25");

  const firstRawCount = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM raw_source_records WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(firstRawCount.rows[0]?.count, "25");

  const firstCheckpoint = await loadCheckpoint(sourceDefinitionId);
  assert.deepEqual(firstCheckpoint?.checkpoint, { nextSequence: 25 });
  assert.equal(firstCheckpoint?.schemaVersion, "test-synthetic-checkpoint-v1");

  const unitCounts = await pool.query<{ ordinal: number; accepted_record_count: number; inserted_record_count: number }>(
    `SELECT ordinal, accepted_record_count, inserted_record_count
     FROM collection_work_units WHERE run_id = $1 ORDER BY ordinal`,
    [firstRun.id],
  );
  assert.deepEqual(
    unitCounts.rows.map((row) => [row.ordinal, row.accepted_record_count, row.inserted_record_count]),
    [[0, 10, 10], [1, 10, 10], [2, 5, 5]],
  );

  // Simulate provider redelivery from an earlier durable cursor. Identical raw truth must not duplicate.
  await pool.query(
    `UPDATE source_checkpoints
     SET checkpoint = '{"nextSequence":0}'::jsonb, revision = revision + 1, updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  await runSyntheticToCompletion("acceptance-worker-2");

  const replayRun = await latestRun(sourceDefinitionId);
  assert.equal(replayRun.state, "SUCCEEDED");
  assert.equal(replayRun.raw_records_accepted, "25");
  assert.equal(replayRun.raw_records_inserted, "0", "identical redelivery must be idempotent");
  const replayRawCount = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM raw_source_records WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(replayRawCount.rows[0]?.count, "25");
  assert.deepEqual((await loadCheckpoint(sourceDefinitionId))?.checkpoint, { nextSequence: 25 });

  // A failed work unit must not advance the checkpoint and a retryable failure must requeue the same unit.
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  const failedRun = await claimNextRun("failure-worker", 60);
  assert.ok(failedRun);
  const adapter = adapterRegistry.get(sourceKey);
  assert.ok(adapter);
  const checkpointBeforeFailure = await loadCheckpoint(sourceDefinitionId);
  const planned = adapter.workDescriptorSchema.parse(await adapter.plan({ checkpoint: checkpointBeforeFailure?.checkpoint ?? null }));
  await ensureWorkUnit(failedRun.id, planned);
  const failedWork = await claimNextWorkUnit(failedRun.id, "failure-worker", 60);
  assert.ok(failedWork);
  await persistWorkFailure({
    run: failedRun,
    work: failedWork,
    workerId: "failure-worker",
    failure: { code: "RATE_LIMITED", retryable: true, message: "runtime acceptance fixture" },
    maxAttempts: 3,
  });
  assert.deepEqual((await loadCheckpoint(sourceDefinitionId))?.checkpoint, checkpointBeforeFailure?.checkpoint);
  const retryState = await pool.query<{ run_state: string; work_state: string }>(
    `SELECT r.state AS run_state, w.state AS work_state
     FROM collection_runs r JOIN collection_work_units w ON w.run_id = r.id
     WHERE r.id = $1 AND w.id = $2`,
    [failedRun.id, failedWork.id],
  );
  assert.deepEqual(retryState.rows[0], { run_state: "QUEUED", work_state: "QUEUED" });

  // Stale run and work leases are reclaimable by another worker.
  const staleRun = await claimNextRun("stale-worker", 10);
  assert.equal(staleRun?.id, failedRun.id);
  const staleWork = await claimNextWorkUnit(failedRun.id, "stale-worker", 10);
  assert.equal(staleWork?.id, failedWork.id);
  await pool.query(
    `UPDATE collection_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [failedRun.id],
  );
  await pool.query(
    `UPDATE collection_work_units SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
    [failedWork.id],
  );
  const reclaimedRun = await claimNextRun("reclaimer-worker", 60);
  assert.equal(reclaimedRun?.id, failedRun.id);
  const reclaimedWork = await claimNextWorkUnit(failedRun.id, "reclaimer-worker", 60);
  assert.equal(reclaimedWork?.id, failedWork.id);

  await setSourceEnabled(sourceKey, false);
  console.log("NODE-1 runtime acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

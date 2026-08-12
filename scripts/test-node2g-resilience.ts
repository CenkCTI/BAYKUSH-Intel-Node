import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { pool } from "../src/db/pool.js";
import { CollectionFailure } from "../src/runtime/failure.js";
import { normalizerTick, normalizationQueueDepth } from "../src/runtime/normalization.js";
import {
  claimNextRun,
  claimNextWorkUnit,
  enqueueDueRuns,
  ensureWorkUnit,
  setSourceEnabled,
} from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { adapterRegistry } from "../src/sources/registry.js";

interface CheckpointSnapshot {
  revision: number;
  checkpoint: unknown;
}

interface HealthSnapshot {
  health_status: string;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  consecutive_failures: number;
  latest_failure_code: string | null;
  latest_failure_message: string | null;
}

async function sourceId(sourceKey: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    "SELECT id FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const id = result.rows[0]?.id;
  assert.ok(id, `${sourceKey} source definition must exist`);
  return id;
}

async function checkpoint(sourceKey: string): Promise<CheckpointSnapshot | null> {
  const result = await pool.query<CheckpointSnapshot>(
    `SELECT c.revision, c.checkpoint
       FROM source_checkpoints c
       JOIN source_definitions d ON d.id = c.source_definition_id
      WHERE d.source_key = $1`,
    [sourceKey],
  );
  return result.rows[0] ?? null;
}

async function health(sourceKey: string): Promise<HealthSnapshot> {
  const result = await pool.query<HealthSnapshot>(
    `SELECT h.health_status, h.last_attempt_at, h.last_success_at, h.last_failure_at,
            h.consecutive_failures, h.latest_failure_code, h.latest_failure_message
       FROM source_health h
       JOIN source_definitions d ON d.id = h.source_definition_id
      WHERE d.source_key = $1`,
    [sourceKey],
  );
  const row = result.rows[0];
  assert.ok(row, `${sourceKey} health state must exist`);
  return row;
}

async function restoreHealth(sourceKey: string, snapshot: HealthSnapshot): Promise<void> {
  await pool.query(
    `UPDATE source_health h
        SET health_status = $2,
            last_attempt_at = $3,
            last_success_at = $4,
            last_failure_at = $5,
            consecutive_failures = $6,
            latest_failure_code = $7,
            latest_failure_message = $8,
            updated_at = now()
       FROM source_definitions d
      WHERE h.source_definition_id = d.id
        AND d.source_key = $1`,
    [
      sourceKey,
      snapshot.health_status,
      snapshot.last_attempt_at,
      snapshot.last_success_at,
      snapshot.last_failure_at,
      snapshot.consecutive_failures,
      snapshot.latest_failure_code,
      snapshot.latest_failure_message,
    ],
  );
}

async function insertManualRun(sourceKey: string, label: string): Promise<string> {
  const id = await sourceId(sourceKey);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO collection_runs(
       source_definition_id, trigger, purpose, state, idempotency_key, scheduled_for, available_at
     ) VALUES ($1, 'MANUAL', 'LIVE_INCREMENTAL', 'QUEUED', $2, now(), now())
     RETURNING id`,
    [id, `node2g-resilience:${label}:${randomUUID()}`],
  );
  const runId = result.rows[0]?.id;
  assert.ok(runId);
  return runId;
}

async function runState(runId: string) {
  const result = await pool.query<{
    state: string;
    attempt_count: number;
    available_at: Date;
    failure_code: string | null;
  }>(
    "SELECT state, attempt_count, available_at, failure_code FROM collection_runs WHERE id = $1",
    [runId],
  );
  const row = result.rows[0];
  assert.ok(row, `run ${runId} must exist`);
  return row;
}

async function workState(runId: string) {
  const result = await pool.query<{
    id: string;
    state: string;
    attempt_count: number;
    available_at: Date;
    lease_owner: string | null;
    lease_expires_at: Date | null;
    failure_code: string | null;
  }>(
    `SELECT id, state, attempt_count, available_at, lease_owner, lease_expires_at, failure_code
       FROM collection_work_units
      WHERE run_id = $1
      ORDER BY ordinal
      LIMIT 1`,
    [runId],
  );
  const row = result.rows[0];
  assert.ok(row, `run ${runId} must have a work unit`);
  return row;
}

async function makeRetryAvailable(runId: string): Promise<void> {
  await pool.query(
    `UPDATE collection_runs
        SET available_at = now(), updated_at = now()
      WHERE id = $1 AND state = 'QUEUED'`,
    [runId],
  );
  await pool.query(
    `UPDATE collection_work_units
        SET available_at = now(), updated_at = now()
      WHERE run_id = $1 AND state = 'QUEUED'`,
    [runId],
  );
}

async function driveRunToSuccess(runId: string, workerId: string): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const state = await runState(runId);
    if (state.state === "SUCCEEDED") return;
    assert.notEqual(state.state, "FAILED", `run ${runId} failed unexpectedly`);
    const didWork = await workerTick(workerId);
    assert.equal(didWork, true, `worker must make progress for ${runId}`);
  }
  assert.fail(`run ${runId} did not complete within bounded worker ticks`);
}

async function drainNormalization(): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (await normalizationQueueDepth() === 0) return;
    const didWork = await normalizerTick("node2g-resilience-normalizer");
    assert.equal(didWork, true, "normalizer must make progress while work is queued");
  }
  assert.fail("normalization queue did not drain within bounded ticks");
}

async function driveNormalizationJobToSuccess(jobId: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM normalization_jobs WHERE id = $1",
      [jobId],
    );
    const state = result.rows[0]?.state;
    assert.ok(state, `normalization job ${jobId} must exist`);
    if (state === "SUCCEEDED") return;
    assert.notEqual(state, "FAILED", `normalization job ${jobId} failed during lease recovery`);
    const didWork = await normalizerTick("node2g-recovery-normalizer");
    assert.equal(didWork, true, "normalizer must make progress until the expired target job is reclaimed");
  }
  assert.fail(`normalization job ${jobId} did not recover within bounded ticks`);
}

async function driveNormalizationJobToFailure(jobId: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const result = await pool.query<{ state: string }>(
      "SELECT state FROM normalization_jobs WHERE id = $1",
      [jobId],
    );
    const state = result.rows[0]?.state;
    assert.ok(state, `normalization job ${jobId} must exist`);
    if (state === "FAILED") return;
    assert.notEqual(state, "SUCCEEDED", `normalization job ${jobId} unexpectedly succeeded during controlled failure`);
    const didWork = await normalizerTick("node2g-resilience-normalizer-failure");
    assert.equal(didWork, true, "normalizer must make progress until the controlled target job fails");
  }
  assert.fail(`normalization job ${jobId} did not fail within bounded ticks`);
}

async function main(): Promise<void> {
  await syncSourceDefinitions([...adapterRegistry.values()]);

  const activeAtStart = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM collection_runs WHERE state IN ('QUEUED','RUNNING')",
  );
  assert.equal(activeAtStart.rows[0]?.count ?? 0, 0, "resilience acceptance requires a quiescent CI runtime");

  const originalCisa = adapterRegistry.get("CISA_KEV");
  const originalSynthetic = adapterRegistry.get("TEST_SYNTHETIC");
  assert.ok(originalCisa);
  assert.ok(originalSynthetic);

  const cisaCheckpointBefore = await checkpoint("CISA_KEV");
  const cisaHealthBefore = await health("CISA_KEV");
  assert.ok(cisaCheckpointBefore, "CISA checkpoint must exist from NODE-2B acceptance");

  // F1/F2/F3: one provider fails; unrelated work succeeds; checkpoint is frozen;
  // retry timestamps enforce exponential backoff instead of a hot loop.
  adapterRegistry.set("CISA_KEV", {
    ...originalCisa,
    async fetch() {
      throw new CollectionFailure("PROVIDER_ERROR", "Controlled NODE-2G resilience provider failure", true);
    },
  });

  const failedRunId = await insertManualRun("CISA_KEV", "provider-failure");
  assert.equal(await workerTick("node2g-resilience-failing-worker"), true);

  let failedRun = await runState(failedRunId);
  let failedWork = await workState(failedRunId);
  assert.equal(failedRun.state, "QUEUED");
  assert.equal(failedWork.state, "QUEUED");
  assert.equal(failedWork.attempt_count, 1);
  assert.equal(failedRun.failure_code, "PROVIDER_ERROR");
  assert.ok(failedRun.available_at.getTime() >= Date.now() + (config.workerRetryBaseSeconds * 1000) - 1_500);
  assert.deepEqual(await checkpoint("CISA_KEV"), cisaCheckpointBefore, "failed source work must not advance checkpoint state");

  const syntheticIsolationRun = await insertManualRun("TEST_SYNTHETIC", "failure-isolation-control");
  await driveRunToSuccess(syntheticIsolationRun, "node2g-resilience-control-worker");
  assert.equal((await runState(syntheticIsolationRun)).state, "SUCCEEDED", "unrelated source must succeed while CISA is in backoff");

  await makeRetryAvailable(failedRunId);
  assert.equal(await workerTick("node2g-resilience-failing-worker"), true);
  failedRun = await runState(failedRunId);
  failedWork = await workState(failedRunId);
  assert.equal(failedRun.state, "QUEUED");
  assert.equal(failedWork.attempt_count, 2);
  assert.ok(failedRun.available_at.getTime() >= Date.now() + (Math.min(config.workerRetryMaxSeconds, config.workerRetryBaseSeconds * 2) * 1000) - 1_500);
  assert.deepEqual(await checkpoint("CISA_KEV"), cisaCheckpointBefore);

  await makeRetryAvailable(failedRunId);
  assert.equal(await workerTick("node2g-resilience-failing-worker"), true);
  failedRun = await runState(failedRunId);
  failedWork = await workState(failedRunId);
  assert.equal(failedRun.state, "FAILED", "third retryable failure must terminate at configured attempt ceiling");
  assert.equal(failedWork.state, "FAILED");
  assert.equal(failedWork.attempt_count, config.workerMaxAttempts);
  assert.deepEqual(await checkpoint("CISA_KEV"), cisaCheckpointBefore);
  adapterRegistry.set("CISA_KEV", originalCisa);
  await restoreHealth("CISA_KEV", cisaHealthBefore);

  // F4: normalization failure may fail the derived job, but immutable raw evidence survives.
  const queuedNormalization = await pool.query<{ id: string; raw_record_id: string; payload_sha256: string }>(
    `SELECT j.id, r.id AS raw_record_id, r.payload_sha256
       FROM normalization_jobs j
       JOIN raw_source_records r ON r.id = j.raw_record_id
       JOIN source_definitions d ON d.id = j.source_definition_id
      WHERE d.source_key = 'TEST_SYNTHETIC' AND j.state = 'QUEUED'
      ORDER BY j.created_at
      LIMIT 1`,
  );
  const normalizationTarget = queuedNormalization.rows[0];
  assert.ok(normalizationTarget, "synthetic collection must enqueue normalization work");

  adapterRegistry.set("TEST_SYNTHETIC", {
    ...originalSynthetic,
    normalize() {
      throw new Error("Controlled NODE-2G normalization failure");
    },
  });
  await driveNormalizationJobToFailure(normalizationTarget.id);

  const failedNormalization = await pool.query<{ state: string; failure_code: string | null }>(
    "SELECT state, failure_code FROM normalization_jobs WHERE id = $1",
    [normalizationTarget.id],
  );
  assert.equal(failedNormalization.rows[0]?.state, "FAILED");
  assert.equal(failedNormalization.rows[0]?.failure_code, "NORMALIZATION_SCHEMA_ERROR");

  const rawAfterNormalizationFailure = await pool.query<{ payload_sha256: string }>(
    "SELECT payload_sha256 FROM raw_source_records WHERE id = $1",
    [normalizationTarget.raw_record_id],
  );
  assert.equal(rawAfterNormalizationFailure.rows[0]?.payload_sha256, normalizationTarget.payload_sha256, "normalization failure must preserve immutable raw evidence");
  const canonicalAfterFailure = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM canonical_evidence_records WHERE raw_record_id = $1",
    [normalizationTarget.raw_record_id],
  );
  assert.equal(canonicalAfterFailure.rows[0]?.count ?? 0, 0, "failed normalization must not manufacture partial canonical evidence");

  adapterRegistry.set("TEST_SYNTHETIC", originalSynthetic);
  await pool.query(
    `UPDATE normalization_jobs j
        SET state = 'QUEUED', available_at = now(), finished_at = NULL,
            lease_owner = NULL, lease_expires_at = NULL,
            failure_code = NULL, failure_message = NULL, updated_at = now()
       FROM source_definitions d
      WHERE j.source_definition_id = d.id
        AND d.source_key = 'TEST_SYNTHETIC'
        AND j.state = 'FAILED'
        AND j.failure_code = 'NORMALIZATION_SCHEMA_ERROR'`,
  );
  await drainNormalization();
  const repairedNormalization = await pool.query<{ state: string }>(
    "SELECT state FROM normalization_jobs WHERE id = $1",
    [normalizationTarget.id],
  );
  assert.equal(repairedNormalization.rows[0]?.state, "SUCCEEDED");

  // F5/F6: a dead worker lease can be reclaimed without duplicate raw/canonical evidence.
  const crashRunId = await insertManualRun("TEST_SYNTHETIC", "expired-worker-lease");
  const claimedRun = await claimNextRun("node2g-dead-worker", 10);
  assert.equal(claimedRun?.id, crashRunId);
  const syntheticCheckpoint = await checkpoint("TEST_SYNTHETIC");
  const planned = await originalSynthetic.plan({ checkpoint: syntheticCheckpoint?.checkpoint ?? null });
  await ensureWorkUnit(crashRunId, planned);
  const claimedWork = await claimNextWorkUnit(crashRunId, "node2g-dead-worker", 10);
  assert.ok(claimedWork);
  await pool.query(
    "UPDATE collection_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [crashRunId],
  );
  await pool.query(
    "UPDATE collection_work_units SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
    [claimedWork.id],
  );
  assert.equal(await workerTick("node2g-recovery-worker"), true, "expired worker lease must be reclaimable");
  await driveRunToSuccess(crashRunId, "node2g-recovery-worker");

  const duplicateRaw = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT source_definition_id, source_record_id, payload_sha256
         FROM raw_source_records
        GROUP BY 1,2,3 HAVING count(*) > 1
     ) duplicate_raw`,
  );
  assert.equal(duplicateRaw.rows[0]?.count ?? 0, 0);

  const crashNormalizationJob = await pool.query<{ id: string }>(
    `SELECT j.id
       FROM normalization_jobs j
       JOIN source_definitions d ON d.id = j.source_definition_id
      WHERE d.source_key = 'TEST_SYNTHETIC' AND j.state = 'QUEUED'
      ORDER BY j.created_at
      LIMIT 1`,
  );
  const crashJobId = crashNormalizationJob.rows[0]?.id;
  assert.ok(crashJobId);
  await pool.query(
    `UPDATE normalization_jobs
        SET state = 'RUNNING', attempt_count = attempt_count + 1,
            lease_owner = 'node2g-dead-normalizer',
            lease_expires_at = now() - interval '1 second',
            started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = $1`,
    [crashJobId],
  );
  await driveNormalizationJobToSuccess(crashJobId);
  await drainNormalization();

  // F6 scheduler idempotency: repeated scheduler ticks/restarts cannot create two active runs.
  await setSourceEnabled("TEST_SYNTHETIC", true);
  const firstEnqueue = await enqueueDueRuns(["TEST_SYNTHETIC"], 10);
  assert.equal(firstEnqueue, 1, "first due scheduler tick must enqueue one run");
  await pool.query(
    `UPDATE source_schedule_state s
        SET next_due_at = now(), updated_at = now()
       FROM source_definitions d
      WHERE s.source_definition_id = d.id AND d.source_key = 'TEST_SYNTHETIC'`,
  );
  const secondEnqueue = await enqueueDueRuns(["TEST_SYNTHETIC"], 10);
  assert.equal(secondEnqueue, 0, "active scheduled run must suppress duplicate scheduler enqueue");
  const activeSynthetic = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM collection_runs r JOIN source_definitions d ON d.id = r.source_definition_id
      WHERE d.source_key = 'TEST_SYNTHETIC' AND r.state IN ('QUEUED','RUNNING')`,
  );
  assert.equal(activeSynthetic.rows[0]?.count ?? 0, 1);
  const scheduledRun = await pool.query<{ id: string }>(
    `SELECT r.id FROM collection_runs r JOIN source_definitions d ON d.id = r.source_definition_id
      WHERE d.source_key = 'TEST_SYNTHETIC' AND r.state IN ('QUEUED','RUNNING') ORDER BY r.created_at LIMIT 1`,
  );
  const scheduledRunId = scheduledRun.rows[0]?.id;
  assert.ok(scheduledRunId);
  await driveRunToSuccess(scheduledRunId, "node2g-scheduler-recovery-worker");
  await drainNormalization();
  await setSourceEnabled("TEST_SYNTHETIC", false);

  const duplicateCanonical = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT raw_record_id, normalization_version, canonical_key, record_kind
         FROM canonical_evidence_records
        GROUP BY 1,2,3,4 HAVING count(*) > 1
     ) duplicate_canonical`,
  );
  assert.equal(duplicateCanonical.rows[0]?.count ?? 0, 0);

  const duplicateActive = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT source_definition_id
         FROM collection_runs
        WHERE state IN ('QUEUED','RUNNING')
        GROUP BY source_definition_id HAVING count(*) > 1
     ) duplicates`,
  );
  assert.equal(duplicateActive.rows[0]?.count ?? 0, 0);
  assert.equal(await normalizationQueueDepth(), 0);

  console.log("NODE-2G deterministic resilience acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

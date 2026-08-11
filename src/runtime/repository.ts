import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import type { ClassifiedFailure, SourceAdapter } from "../contracts/source.js";
import { canonicalJsonStringify, type PreparedRawRecord } from "./raw-record.js";

export interface ClaimedRun {
  id: string;
  sourceDefinitionId: string;
  sourceKey: string;
  trigger: string;
  purpose: string;
}

export interface ClaimedWorkUnit {
  id: string;
  runId: string;
  ordinal: number;
  descriptor: unknown;
  attemptCount: number;
}

export async function setSourceEnabled(sourceKey: string, enabled: boolean): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `UPDATE source_definitions
       SET enabled = $2, updated_at = now()
       WHERE source_key = $1
       RETURNING id`,
      [sourceKey, enabled],
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error(`Unknown source: ${sourceKey}`);
    await client.query(
      `UPDATE source_schedule_state
       SET next_due_at = LEAST(next_due_at, now()), updated_at = now()
       WHERE source_definition_id = $1`,
      [id],
    );
    await client.query(
      `UPDATE source_health
       SET health_status = $2, updated_at = now()
       WHERE source_definition_id = $1`,
      [id, enabled ? "UNKNOWN" : "PAUSED"],
    );
  });
}

export async function enqueueDueRuns(sourceKeys: readonly string[], limit = 10): Promise<number> {
  if (!sourceKeys.length) return 0;
  return withTransaction(async (client) => {
    const due = await client.query<{
      source_definition_id: string;
      source_key: string;
      default_poll_interval_seconds: number;
      next_due_at: Date;
    }>(
      `SELECT d.id AS source_definition_id, d.source_key,
              d.default_poll_interval_seconds, s.next_due_at
       FROM source_schedule_state s
       JOIN source_definitions d ON d.id = s.source_definition_id
       WHERE d.enabled = true
         AND d.source_key = ANY($1::text[])
         AND d.default_poll_interval_seconds IS NOT NULL
         AND s.next_due_at <= now()
         AND NOT EXISTS (
           SELECT 1 FROM collection_runs r
           WHERE r.source_definition_id = d.id
             AND r.state IN ('QUEUED','RUNNING')
         )
       ORDER BY s.next_due_at
       FOR UPDATE OF s SKIP LOCKED
       LIMIT $2`,
      [sourceKeys, limit],
    );

    let inserted = 0;
    for (const row of due.rows) {
      const scheduledFor = row.next_due_at.toISOString();
      const idempotencyKey = `scheduled:${row.source_key}:${scheduledFor}`;
      const run = await client.query(
        `INSERT INTO collection_runs(
           source_definition_id, trigger, purpose, state, idempotency_key, scheduled_for
         ) VALUES ($1, 'SCHEDULED', 'LIVE_INCREMENTAL', 'QUEUED', $2, $3)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [row.source_definition_id, idempotencyKey, scheduledFor],
      );
      inserted += run.rowCount ?? 0;
      await client.query(
        `UPDATE source_schedule_state
         SET last_enqueued_at = now(),
             next_due_at = now() + ($2::text || ' seconds')::interval,
             updated_at = now()
         WHERE source_definition_id = $1`,
        [row.source_definition_id, row.default_poll_interval_seconds],
      );
    }
    return inserted;
  });
}

export async function claimNextRun(workerId: string, leaseSeconds: number): Promise<ClaimedRun | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      source_definition_id: string;
      source_key: string;
      trigger: string;
      purpose: string;
    }>(
      `SELECT r.id, r.source_definition_id, d.source_key, r.trigger, r.purpose
       FROM collection_runs r
       JOIN source_definitions d ON d.id = r.source_definition_id
       WHERE r.state = 'QUEUED'
          OR (r.state = 'RUNNING' AND r.lease_expires_at < now())
       ORDER BY r.created_at
       FOR UPDATE OF r SKIP LOCKED
       LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE collection_runs
       SET state = 'RUNNING', started_at = COALESCE(started_at, now()),
           lease_owner = $2, lease_expires_at = now() + ($3::text || ' seconds')::interval,
           updated_at = now()
       WHERE id = $1`,
      [row.id, workerId, leaseSeconds],
    );
    return {
      id: row.id,
      sourceDefinitionId: row.source_definition_id,
      sourceKey: row.source_key,
      trigger: row.trigger,
      purpose: row.purpose,
    };
  });
}

export async function loadCheckpoint(sourceDefinitionId: string): Promise<{ schemaVersion: string; checkpoint: unknown } | null> {
  const result = await pool.query<{ checkpoint_schema_version: string; checkpoint: unknown }>(
    `SELECT checkpoint_schema_version, checkpoint
     FROM source_checkpoints WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  return row ? { schemaVersion: row.checkpoint_schema_version, checkpoint: row.checkpoint } : null;
}

function workKey(descriptor: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(descriptor)).digest("hex");
}

export async function ensureWorkUnit(runId: string, descriptor: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO collection_work_units(run_id, ordinal, work_key, descriptor, state)
     SELECT $1, 0, $2, $3::jsonb, 'QUEUED'
     WHERE NOT EXISTS (SELECT 1 FROM collection_work_units WHERE run_id = $1)
     ON CONFLICT DO NOTHING`,
    [runId, workKey(descriptor), canonicalJsonStringify(descriptor)],
  );
}

export async function claimNextWorkUnit(runId: string, workerId: string, leaseSeconds: number): Promise<ClaimedWorkUnit | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      run_id: string;
      ordinal: number;
      descriptor: unknown;
      attempt_count: number;
    }>(
      `SELECT id, run_id, ordinal, descriptor, attempt_count
       FROM collection_work_units
       WHERE run_id = $1
         AND (state = 'QUEUED' OR (state = 'RUNNING' AND lease_expires_at < now()))
       ORDER BY ordinal
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [runId],
    );
    const row = selected.rows[0];
    if (!row) return null;
    const claimed = await client.query<{ attempt_count: number }>(
      `UPDATE collection_work_units
       SET state = 'RUNNING', attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, now()), lease_owner = $2,
           lease_expires_at = now() + ($3::text || ' seconds')::interval,
           updated_at = now()
       WHERE id = $1
       RETURNING attempt_count`,
      [row.id, workerId, leaseSeconds],
    );
    return {
      id: row.id,
      runId: row.run_id,
      ordinal: row.ordinal,
      descriptor: row.descriptor,
      attemptCount: claimed.rows[0]?.attempt_count ?? row.attempt_count + 1,
    };
  });
}

export async function recordSourceAttempt(sourceDefinitionId: string): Promise<void> {
  await pool.query(
    `UPDATE source_health
     SET last_attempt_at = now(), updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
}

async function assertLease(client: PoolClient, runId: string, workUnitId: string, workerId: string): Promise<void> {
  const leased = await client.query(
    `SELECT 1
     FROM collection_runs r
     JOIN collection_work_units w ON w.run_id = r.id
     WHERE r.id = $1 AND w.id = $2
       AND r.state = 'RUNNING' AND w.state = 'RUNNING'
       AND r.lease_owner = $3 AND w.lease_owner = $3
     FOR UPDATE OF r, w`,
    [runId, workUnitId, workerId],
  );
  if (!leased.rowCount) throw new Error("Collection lease was lost before persistence");
}

export async function persistWorkSuccess(input: {
  run: ClaimedRun;
  work: ClaimedWorkUnit;
  workerId: string;
  adapter: SourceAdapter;
  records: readonly PreparedRawRecord[];
  nextCheckpoint: unknown;
  nextWork: unknown | null;
  complete: boolean;
}): Promise<void> {
  await withTransaction(async (client) => {
    await assertLease(client, input.run.id, input.work.id, input.workerId);
    let inserted = 0;
    for (const record of input.records) {
      const result = await client.query(
        `INSERT INTO raw_source_records(
           source_definition_id, collection_run_id, collection_work_unit_id,
           source_record_id, payload_sha256, payload, published_at, effective_at,
           upstream_updated_at, source_url, adapter_version, source_schema_version
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (source_definition_id, source_record_id, payload_sha256) DO NOTHING`,
        [
          input.run.sourceDefinitionId, input.run.id, input.work.id,
          record.sourceRecordId, record.payloadSha256, record.payloadJson,
          record.publishedAt, record.effectiveAt, record.upstreamUpdatedAt,
          record.sourceUrl, input.adapter.definition.adapterVersion, record.sourceSchemaVersion,
        ],
      );
      inserted += result.rowCount ?? 0;
    }

    const checkpointJson = canonicalJsonStringify(input.nextCheckpoint);
    await client.query(
      `INSERT INTO source_checkpoints(
         source_definition_id, checkpoint_schema_version, checkpoint, revision, updated_by_run_id
       ) VALUES ($1,$2,$3::jsonb,1,$4)
       ON CONFLICT (source_definition_id) DO UPDATE
       SET checkpoint_schema_version = EXCLUDED.checkpoint_schema_version,
           checkpoint = EXCLUDED.checkpoint,
           revision = source_checkpoints.revision + 1,
           updated_by_run_id = EXCLUDED.updated_by_run_id,
           updated_at = now()`,
      [input.run.sourceDefinitionId, input.adapter.checkpointSchemaVersion, checkpointJson, input.run.id],
    );

    await client.query(
      `UPDATE collection_work_units
       SET state = 'SUCCEEDED', accepted_record_count = $2, inserted_record_count = $3,
           finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
           failure_code = NULL, failure_message = NULL, updated_at = now()
       WHERE id = $1`,
      [input.work.id, input.records.length, inserted],
    );

    if (!input.complete && input.nextWork !== null) {
      await client.query(
        `INSERT INTO collection_work_units(run_id, ordinal, work_key, descriptor, state)
         VALUES ($1,$2,$3,$4::jsonb,'QUEUED')
         ON CONFLICT DO NOTHING`,
        [
          input.run.id,
          input.work.ordinal + 1,
          workKey(input.nextWork),
          canonicalJsonStringify(input.nextWork),
        ],
      );
    }

    await client.query(
      `UPDATE collection_runs
       SET state = $2,
           finished_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE NULL END,
           lease_owner = NULL, lease_expires_at = NULL,
           work_units_succeeded = work_units_succeeded + 1,
           raw_records_accepted = raw_records_accepted + $3,
           raw_records_inserted = raw_records_inserted + $4,
           failure_code = NULL, failure_message = NULL, updated_at = now()
       WHERE id = $1`,
      [input.run.id, input.complete ? "SUCCEEDED" : "QUEUED", input.records.length, inserted],
    );

    if (input.complete) {
      await client.query(
        `UPDATE source_health
         SET health_status = 'HEALTHY', last_success_at = now(), consecutive_failures = 0,
             latest_failure_code = NULL, latest_failure_message = NULL, updated_at = now()
         WHERE source_definition_id = $1`,
        [input.run.sourceDefinitionId],
      );
    }
  });
}

export async function persistWorkFailure(input: {
  run: ClaimedRun;
  work: ClaimedWorkUnit;
  workerId: string;
  failure: ClassifiedFailure;
  maxAttempts: number;
}): Promise<void> {
  await withTransaction(async (client) => {
    await assertLease(client, input.run.id, input.work.id, input.workerId);
    const retry = input.failure.retryable && input.work.attemptCount < input.maxAttempts;
    await client.query(
      `UPDATE collection_work_units
       SET state = $2, lease_owner = NULL, lease_expires_at = NULL,
           finished_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END,
           failure_code = $3, failure_message = $4, updated_at = now()
       WHERE id = $1`,
      [input.work.id, retry ? "QUEUED" : "FAILED", input.failure.code, input.failure.message],
    );
    await client.query(
      `UPDATE collection_runs
       SET state = $2, lease_owner = NULL, lease_expires_at = NULL,
           finished_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END,
           attempt_count = attempt_count + 1,
           failure_code = $3, failure_message = $4, updated_at = now()
       WHERE id = $1`,
      [input.run.id, retry ? "QUEUED" : "FAILED", input.failure.code, input.failure.message],
    );
    await client.query(
      `UPDATE source_health
       SET health_status = $2, last_failure_at = now(),
           consecutive_failures = consecutive_failures + 1,
           latest_failure_code = $3, latest_failure_message = $4, updated_at = now()
       WHERE source_definition_id = $1`,
      [input.run.sourceDefinitionId, retry ? "DEGRADED" : "FAILED", input.failure.code, input.failure.message],
    );
  });
}

export async function failClaimedRun(run: ClaimedRun, workerId: string, failure: ClassifiedFailure): Promise<void> {
  await pool.query(
    `UPDATE collection_runs
     SET state = 'FAILED', finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
         failure_code = $3, failure_message = $4, updated_at = now()
     WHERE id = $1 AND lease_owner = $2 AND state = 'RUNNING'`,
    [run.id, workerId, failure.code, failure.message],
  );
  await pool.query(
    `UPDATE source_health
     SET health_status = 'FAILED', last_failure_at = now(), consecutive_failures = consecutive_failures + 1,
         latest_failure_code = $2, latest_failure_message = $3, updated_at = now()
     WHERE source_definition_id = $1`,
    [run.sourceDefinitionId, failure.code, failure.message],
  );
}

export async function recordHeartbeat(component: "API" | "SCHEDULER" | "WORKER", instanceId: string, metadata: Record<string, unknown> = {}): Promise<void> {
  await pool.query(
    `INSERT INTO runtime_heartbeats(component, instance_id, heartbeat_at, metadata)
     VALUES ($1,$2,now(),$3::jsonb)
     ON CONFLICT (component, instance_id) DO UPDATE
     SET heartbeat_at = EXCLUDED.heartbeat_at, metadata = EXCLUDED.metadata`,
    [component, instanceId, canonicalJsonStringify(metadata)],
  );
}

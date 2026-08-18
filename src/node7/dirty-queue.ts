import { pool } from "../db/pool.js";

export interface ClaimedDirtyEntity {
  entityId: string;
  dirtyRevision: number;
  attemptCount: number;
}

export async function claimDirtyEntity(input: {
  workerId: string;
  leaseSeconds: number;
  maxAttempts: number;
}): Promise<ClaimedDirtyEntity | null> {
  const result = await pool.query<{
    entity_id: string;
    dirty_revision: string;
    attempt_count: number;
  }>(
    `WITH candidate AS (
       SELECT entity_id
       FROM node7_dirty_entities
       WHERE available_at <= now()
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
         AND attempt_count < $3
       ORDER BY dirty_since,entity_id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE node7_dirty_entities queue
     SET lease_owner=$1,
         lease_expires_at=now()+make_interval(secs=>$2),
         attempt_count=queue.attempt_count+1,
         updated_at=now()
     FROM candidate
     WHERE queue.entity_id=candidate.entity_id
     RETURNING queue.entity_id,queue.dirty_revision::text,queue.attempt_count`,
    [input.workerId, input.leaseSeconds, input.maxAttempts],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    entityId: row.entity_id,
    dirtyRevision: Number(row.dirty_revision),
    attemptCount: row.attempt_count,
  };
}

export async function completeDirtyEntity(input: {
  workerId: string;
  entityId: string;
  dirtyRevision: number;
}): Promise<void> {
  const deleted = await pool.query(
    `DELETE FROM node7_dirty_entities
     WHERE entity_id=$1 AND dirty_revision=$2 AND lease_owner=$3`,
    [input.entityId, input.dirtyRevision, input.workerId],
  );
  if ((deleted.rowCount ?? 0) > 0) return;

  await pool.query(
    `UPDATE node7_dirty_entities
     SET lease_owner=NULL,lease_expires_at=NULL,available_at=LEAST(available_at,now()),updated_at=now()
     WHERE entity_id=$1 AND lease_owner=$2`,
    [input.entityId, input.workerId],
  );
}

export async function failDirtyEntity(input: {
  workerId: string;
  entityId: string;
  attemptCount: number;
  retryBaseSeconds: number;
  retryMaxSeconds: number;
  error: unknown;
}): Promise<void> {
  const delay = Math.min(
    input.retryMaxSeconds,
    input.retryBaseSeconds * 2 ** Math.max(0, input.attemptCount - 1),
  );
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await pool.query(
    `UPDATE node7_dirty_entities
     SET lease_owner=NULL,
         lease_expires_at=NULL,
         available_at=now()+make_interval(secs=>$3),
         last_failure_code='NODE7_PROJECTION_FAILED',
         last_failure_message=left($4,2000),
         updated_at=now()
     WHERE entity_id=$1 AND lease_owner=$2`,
    [input.entityId, input.workerId, delay, message],
  );
}

export async function dirtyQueueDepth(): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM node7_dirty_entities`);
  return Number(result.rows[0]?.count ?? 0);
}

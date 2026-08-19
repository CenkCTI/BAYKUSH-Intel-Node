import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

export type Node7ActivityResolution = "HOUR" | "DAY";

export interface ActivityWindow {
  resolution: Node7ActivityResolution;
  start: string;
  end: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function floorHour(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), 0, 0, 0,
  ));
}

function floorDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

export function activityWindowsForObservation(input: {
  observedTime: string | null;
  observedDate: string | null;
  timePrecision: "INSTANT" | "DATE";
}): ActivityWindow[] {
  if (input.timePrecision === "DATE") {
    if (!input.observedDate || input.observedTime) throw new Error("DATE observation requires observedDate only");
    const day = new Date(`${input.observedDate}T00:00:00.000Z`);
    if (!Number.isFinite(day.getTime())) throw new Error("Invalid observedDate");
    return [{
      resolution: "DAY",
      start: day.toISOString(),
      end: new Date(day.getTime() + 86_400_000).toISOString(),
    }];
  }

  if (!input.observedTime || input.observedDate) throw new Error("INSTANT observation requires observedTime only");
  const instant = new Date(input.observedTime);
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid observedTime");
  const hour = floorHour(instant);
  const day = floorDay(instant);
  return [
    {
      resolution: "HOUR",
      start: hour.toISOString(),
      end: new Date(hour.getTime() + 3_600_000).toISOString(),
    },
    {
      resolution: "DAY",
      start: day.toISOString(),
      end: new Date(day.getTime() + 86_400_000).toISOString(),
    },
  ];
}

interface PendingObservationRow {
  revision_id: string;
  entity_type: string;
  entity_key: string;
  observed_time: Date | null;
  observed_date: string | null;
  time_precision: "INSTANT" | "DATE";
  policy_revision_id: string;
}

export async function queuePendingActivityProjectionJobs(limit = 500): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Invalid NODE-7 activity queue limit");

  const result = await pool.query<PendingObservationRow>(
    `SELECT revision.id AS revision_id, revision.entity_type, revision.entity_key,
            revision.observed_time, revision.observed_date::text, revision.time_precision,
            policy.current_revision_id AS policy_revision_id
     FROM entity_observation_revisions revision
     JOIN node7_entity_capabilities capability
       ON capability.entity_type=revision.entity_type AND capability.convergence_enabled=true
     JOIN node7_derivation_policy_heads policy ON policy.policy_key='CONVERGENCE'
     WHERE NOT EXISTS (
       SELECT 1 FROM node7_projection_receipts receipt
       WHERE receipt.entity_observation_revision_id=revision.id
         AND receipt.policy_revision_id=policy.current_revision_id
         AND receipt.projection_kind='ENTITY_ACTIVITY'
     )
     ORDER BY revision.created_at, revision.id
     LIMIT $1`,
    [limit],
  );

  let queued = 0;
  for (const row of result.rows) {
    const windows = activityWindowsForObservation({
      observedTime: row.observed_time?.toISOString() ?? null,
      observedDate: row.observed_date,
      timePrecision: row.time_precision,
    });
    for (const window of windows) {
      const scope = `${window.resolution}:${window.start}`;
      const idempotencyKey = sha256({
        projectionKind: "ENTITY_ACTIVITY",
        revisionId: row.revision_id,
        policyRevisionId: row.policy_revision_id,
        entityType: row.entity_type,
        entityKey: row.entity_key,
        scope,
      });
      const inserted = await pool.query(
        `INSERT INTO node7_projection_jobs(
           projection_kind,subject_type,subject_key,resolution,window_start,window_end,
           policy_revision_id,trigger_observation_revision_id,idempotency_key
         ) VALUES ('ENTITY_ACTIVITY',$1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          row.entity_type,
          row.entity_key,
          window.resolution,
          window.start,
          window.end,
          row.policy_revision_id,
          row.revision_id,
          idempotencyKey,
        ],
      );
      queued += inserted.rowCount ?? 0;
    }
  }
  return queued;
}

interface ActivityJobRow {
  id: string;
  subject_type: string;
  subject_key: string;
  resolution: Node7ActivityResolution;
  window_start: Date;
  window_end: Date;
  policy_revision_id: string;
  trigger_observation_revision_id: string;
}

interface ActivityObservationRow {
  revision_id: string;
  source_definition_id: string;
  source_key: string;
  upstream_origin_key: string;
  source_class: string;
  observation_basis: string;
  time_precision: "INSTANT" | "DATE";
  observed_time: Date | null;
  observed_date: string | null;
}

async function claimActivityJob(client: PoolClient, workerId: string): Promise<ActivityJobRow | null> {
  const claimed = await client.query<ActivityJobRow>(
    `WITH candidate AS (
       SELECT id FROM node7_projection_jobs
       WHERE projection_kind='ENTITY_ACTIVITY'
         AND state IN ('QUEUED','FAILED')
         AND available_at <= now()
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE node7_projection_jobs job
     SET state='RUNNING', lease_owner=$1, lease_expires_at=now()+interval '2 minutes',
         attempt_count=attempt_count+1, started_at=COALESCE(started_at,now()), updated_at=now(),
         failure_code=NULL, failure_message=NULL
     FROM candidate
     WHERE job.id=candidate.id
     RETURNING job.id,job.subject_type,job.subject_key,job.resolution,
               job.window_start,job.window_end,job.policy_revision_id,
               job.trigger_observation_revision_id`,
    [workerId],
  );
  return claimed.rows[0] ?? null;
}

function activityFingerprint(input: {
  policyRevisionId: string;
  entityType: string;
  entityKey: string;
  resolution: Node7ActivityResolution;
  windowStart: string;
  windowEnd: string;
  revisionIds: string[];
}): string {
  return sha256({
    ...input,
    revisionIds: [...input.revisionIds].sort(),
  });
}

async function recomputeActivityBucket(client: PoolClient, job: ActivityJobRow): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `node7:${job.subject_type}:${job.subject_key}:${job.resolution}:${job.window_start.toISOString()}`,
  ]);

  const observations = await client.query<ActivityObservationRow>(
    `SELECT revision.id AS revision_id, head.source_definition_id,
            source.source_key, source.upstream_origin_key, source.source_class,
            revision.observation_basis, revision.time_precision,
            revision.observed_time, revision.observed_date::text
     FROM entity_observation_heads head
     JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
     JOIN source_definitions source ON source.id=head.source_definition_id
     WHERE head.entity_type=$1 AND head.entity_key=$2 AND head.state='ACTIVE'
       AND (
         ($3='HOUR' AND head.observed_time >= $4 AND head.observed_time < $5)
         OR
         ($3='DAY' AND (
           (head.observed_time >= $4 AND head.observed_time < $5)
           OR (head.observed_date >= $4::timestamptz::date AND head.observed_date < $5::timestamptz::date)
         ))
       )
     ORDER BY revision.id`,
    [job.subject_type, job.subject_key, job.resolution, job.window_start.toISOString(), job.window_end.toISOString()],
  );

  const rows = observations.rows;
  const fingerprint = activityFingerprint({
    policyRevisionId: job.policy_revision_id,
    entityType: job.subject_type,
    entityKey: job.subject_key,
    resolution: job.resolution,
    windowStart: job.window_start.toISOString(),
    windowEnd: job.window_end.toISOString(),
    revisionIds: rows.map((row) => row.revision_id),
  });

  const prior = await client.query<{
    current_revision_id: string;
    revision_number: number;
    input_fingerprint: string;
  }>(
    `SELECT head.current_revision_id, revision.revision_number, revision.input_fingerprint
     FROM entity_activity_bucket_heads head
     JOIN entity_activity_bucket_revisions revision ON revision.id=head.current_revision_id
     WHERE head.entity_type=$1 AND head.entity_key=$2 AND head.resolution=$3 AND head.bucket_start=$4
     FOR UPDATE OF head`,
    [job.subject_type, job.subject_key, job.resolution, job.window_start.toISOString()],
  );
  const previous = prior.rows[0];

  if (previous?.input_fingerprint !== fingerprint) {
    const sources = new Set(rows.map((row) => row.source_definition_id));
    const origins = new Set(rows.map((row) => row.upstream_origin_key));
    const classes = new Set(rows.map((row) => row.source_class));
    const instantCount = rows.filter((row) => row.time_precision === "INSTANT").length;
    const dateCount = rows.filter((row) => row.time_precision === "DATE").length;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO entity_activity_bucket_revisions(
         entity_type,entity_key,resolution,bucket_start,bucket_end,state,
         observation_count,source_definition_count,upstream_origin_count,source_class_count,
         instant_observation_count,date_observation_count,policy_revision_id,input_fingerprint,
         revision_number,supersedes_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        job.subject_type,
        job.subject_key,
        job.resolution,
        job.window_start.toISOString(),
        job.window_end.toISOString(),
        rows.length === 0 ? "EMPTY" : "ACTIVE",
        rows.length,
        sources.size,
        origins.size,
        classes.size,
        instantCount,
        dateCount,
        job.policy_revision_id,
        fingerprint,
        (previous?.revision_number ?? 0) + 1,
        previous?.current_revision_id ?? null,
      ],
    );
    const revisionId = inserted.rows[0]?.id;
    if (!revisionId) throw new Error("NODE-7 activity revision insert failed");

    const grouped = new Map<string, ActivityObservationRow[]>();
    for (const row of rows) {
      const list = grouped.get(row.source_definition_id) ?? [];
      list.push(row);
      grouped.set(row.source_definition_id, list);
    }

    for (const [sourceDefinitionId, members] of grouped) {
      const first = members[0];
      if (!first) continue;
      const instantMembers = members.filter((member) => member.time_precision === "INSTANT" && member.observed_time);
      const dateMembers = members.filter((member) => member.time_precision === "DATE" && member.observed_date);
      const homogeneousInstant = instantMembers.length === members.length;
      const homogeneousDate = dateMembers.length === members.length;
      const instantTimes = instantMembers.map((member) => member.observed_time as Date).sort((a, b) => a.getTime() - b.getTime());
      const dates = dateMembers.map((member) => member.observed_date as string).sort();

      await client.query(
        `INSERT INTO entity_activity_bucket_members(
           bucket_revision_id,source_definition_id,source_key,upstream_origin_key,source_class,
           observation_basis,observation_count,instant_observation_count,date_observation_count,
           first_observed_time,last_observed_time,first_observed_date,last_observed_date
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          revisionId,
          sourceDefinitionId,
          first.source_key,
          first.upstream_origin_key,
          first.source_class,
          first.observation_basis,
          members.length,
          instantMembers.length,
          dateMembers.length,
          homogeneousInstant ? instantTimes[0]?.toISOString() ?? null : null,
          homogeneousInstant ? instantTimes.at(-1)?.toISOString() ?? null : null,
          homogeneousDate ? dates[0] ?? null : null,
          homogeneousDate ? dates.at(-1) ?? null : null,
        ],
      );
    }

    for (const row of rows) {
      await client.query(
        `INSERT INTO entity_activity_bucket_inputs(bucket_revision_id,entity_observation_revision_id)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [revisionId, row.revision_id],
      );
    }

    await client.query(
      `INSERT INTO entity_activity_bucket_heads(
         entity_type,entity_key,resolution,bucket_start,bucket_end,state,current_revision_id,updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (entity_type,entity_key,resolution,bucket_start) DO UPDATE SET
         bucket_end=EXCLUDED.bucket_end,
         state=EXCLUDED.state,
         current_revision_id=EXCLUDED.current_revision_id,
         updated_at=now()`,
      [
        job.subject_type,
        job.subject_key,
        job.resolution,
        job.window_start.toISOString(),
        job.window_end.toISOString(),
        rows.length === 0 ? "EMPTY" : "ACTIVE",
        revisionId,
      ],
    );
  }

  const scope = `${job.resolution}:${job.window_start.toISOString()}`;
  await client.query(
    `INSERT INTO node7_projection_receipts(
       entity_observation_revision_id,policy_revision_id,projection_kind,projection_scope
     ) VALUES ($1,$2,'ENTITY_ACTIVITY',$3)
     ON CONFLICT DO NOTHING`,
    [job.trigger_observation_revision_id, job.policy_revision_id, scope],
  );

  await client.query(
    `UPDATE node7_projection_jobs
     SET state='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now()
     WHERE id=$1`,
    [job.id],
  );
}

export async function processNextActivityProjectionJob(workerId: string): Promise<boolean> {
  if (!workerId.trim()) throw new Error("NODE-7 activity worker requires a worker id");
  return withTransaction(async (client) => {
    const job = await claimActivityJob(client, workerId);
    if (!job) return false;
    try {
      await recomputeActivityBucket(client, job);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown NODE-7 activity projection error";
      await client.query(
        `UPDATE node7_projection_jobs
         SET state='FAILED',lease_owner=NULL,lease_expires_at=NULL,
             available_at=now()+interval '30 seconds',failure_code='ACTIVITY_PROJECTION_FAILED',
             failure_message=$2,finished_at=now(),updated_at=now()
         WHERE id=$1`,
        [job.id, message],
      );
      return false;
    }
  });
}

export async function processNode7ActivityBatch(input: {
  workerId: string;
  queueLimit?: number;
  processLimit?: number;
}): Promise<{ queued: number; processed: number }> {
  const queued = await queuePendingActivityProjectionJobs(input.queueLimit ?? 500);
  const processLimit = input.processLimit ?? 100;
  if (!Number.isInteger(processLimit) || processLimit < 1 || processLimit > 1_000) throw new Error("Invalid NODE-7 process limit");
  let processed = 0;
  for (let index = 0; index < processLimit; index += 1) {
    if (!(await processNextActivityProjectionJob(input.workerId))) break;
    processed += 1;
  }
  return { queued, processed };
}

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";
import {
  classifyNode7Convergence,
  type Node7FindingType,
} from "./contracts.js";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

interface PendingActivityRow {
  activity_revision_id: string;
  entity_type: string;
  entity_key: string;
  resolution: "HOUR" | "DAY";
  bucket_start: Date;
  bucket_end: Date;
  policy_revision_id: string;
}

export async function queuePendingConvergenceJobs(limit = 500): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Invalid NODE-7 convergence queue limit");
  const result = await pool.query<PendingActivityRow>(
    `SELECT revision.id AS activity_revision_id,revision.entity_type,revision.entity_key,
            revision.resolution,revision.bucket_start,revision.bucket_end,
            policy.current_revision_id AS policy_revision_id
     FROM entity_activity_bucket_heads head
     JOIN entity_activity_bucket_revisions revision ON revision.id=head.current_revision_id
     JOIN node7_derivation_policy_heads policy ON policy.policy_key='CONVERGENCE'
     WHERE NOT EXISTS (
       SELECT 1 FROM convergence_projection_receipts receipt
       WHERE receipt.activity_bucket_revision_id=revision.id
         AND receipt.policy_revision_id=policy.current_revision_id
     )
     ORDER BY revision.calculated_at,revision.id
     LIMIT $1`,
    [limit],
  );

  let queued = 0;
  for (const row of result.rows) {
    const idempotencyKey = sha256({
      projectionKind: "CONVERGENCE",
      activityRevisionId: row.activity_revision_id,
      policyRevisionId: row.policy_revision_id,
    });
    const inserted = await pool.query(
      `INSERT INTO node7_projection_jobs(
         projection_kind,subject_type,subject_key,resolution,window_start,window_end,
         policy_revision_id,trigger_activity_bucket_revision_id,idempotency_key
       ) VALUES ('CONVERGENCE',$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        row.entity_type,
        row.entity_key,
        row.resolution,
        row.bucket_start.toISOString(),
        row.bucket_end.toISOString(),
        row.policy_revision_id,
        row.activity_revision_id,
        idempotencyKey,
      ],
    );
    queued += inserted.rowCount ?? 0;
  }
  return queued;
}

interface ConvergenceJobRow {
  id: string;
  subject_type: string;
  subject_key: string;
  resolution: "HOUR" | "DAY";
  window_start: Date;
  window_end: Date;
  policy_revision_id: string;
  trigger_activity_bucket_revision_id: string;
}

async function claimConvergenceJob(client: PoolClient, workerId: string): Promise<ConvergenceJobRow | null> {
  const claimed = await client.query<ConvergenceJobRow>(
    `WITH candidate AS (
       SELECT id FROM node7_projection_jobs
       WHERE projection_kind='CONVERGENCE'
         AND state IN ('QUEUED','FAILED')
         AND available_at <= now()
         AND (lease_expires_at IS NULL OR lease_expires_at < now())
       ORDER BY created_at,id
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE node7_projection_jobs job
     SET state='RUNNING',lease_owner=$1,lease_expires_at=now()+interval '2 minutes',
         attempt_count=attempt_count+1,started_at=COALESCE(started_at,now()),updated_at=now(),
         failure_code=NULL,failure_message=NULL
     FROM candidate
     WHERE job.id=candidate.id
     RETURNING job.id,job.subject_type,job.subject_key,job.resolution,
               job.window_start,job.window_end,job.policy_revision_id,
               job.trigger_activity_bucket_revision_id`,
    [workerId],
  );
  return claimed.rows[0] ?? null;
}

interface ActivityRevisionRow {
  id: string;
  state: "ACTIVE" | "EMPTY";
  observation_count: number;
  source_definition_count: number;
  upstream_origin_count: number;
  source_class_count: number;
  instant_observation_count: number;
  date_observation_count: number;
}

interface ObservationTimeRow {
  time_precision: "INSTANT" | "DATE";
  observed_time: Date | null;
  observed_date: string | null;
}

function findingKey(input: {
  findingType: Node7FindingType;
  entityType: string;
  entityKey: string;
  resolution: "HOUR" | "DAY";
  windowStart: string;
  policyRevisionId: string;
}): string {
  return sha256(input);
}

async function appendFindingRevision(input: {
  client: PoolClient;
  job: ConvergenceJobRow;
  activity: ActivityRevisionRow;
  findingType: Node7FindingType;
  state: "ACTIVE" | "RETRACTED";
  timePrecision: "INSTANT" | "DATE" | "MIXED";
  firstObservedTime: string | null;
  lastObservedTime: string | null;
  firstObservedDate: string | null;
  lastObservedDate: string | null;
  observationSpanSeconds: number | null;
}): Promise<void> {
  const key = findingKey({
    findingType: input.findingType,
    entityType: input.job.subject_type,
    entityKey: input.job.subject_key,
    resolution: input.job.resolution,
    windowStart: input.job.window_start.toISOString(),
    policyRevisionId: input.job.policy_revision_id,
  });

  const prior = await input.client.query<{
    current_revision_id: string;
    revision_number: number;
    state: "ACTIVE" | "RETRACTED";
    input_fingerprint: string;
  }>(
    `SELECT head.current_revision_id,revision.revision_number,revision.state,revision.input_fingerprint
     FROM convergence_finding_heads head
     JOIN convergence_finding_revisions revision ON revision.id=head.current_revision_id
     WHERE head.finding_key=$1
     FOR UPDATE OF head`,
    [key],
  );
  const previous = prior.rows[0];
  const fingerprint = sha256({
    findingType: input.findingType,
    state: input.state,
    activityRevisionId: input.activity.id,
    policyRevisionId: input.job.policy_revision_id,
  });
  if (previous?.input_fingerprint === fingerprint) return;

  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO convergence_finding_revisions(
       finding_key,revision_number,state,finding_type,entity_type,entity_key,resolution,
       window_start,window_end,time_precision,source_definition_count,upstream_origin_count,
       source_class_count,observation_count,first_observed_time,last_observed_time,
       first_observed_date,last_observed_date,observation_span_seconds,policy_revision_id,
       input_fingerprint,supersedes_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING id`,
    [
      key,
      (previous?.revision_number ?? 0) + 1,
      input.state,
      input.findingType,
      input.job.subject_type,
      input.job.subject_key,
      input.job.resolution,
      input.job.window_start.toISOString(),
      input.job.window_end.toISOString(),
      input.timePrecision,
      input.activity.source_definition_count,
      input.activity.upstream_origin_count,
      input.activity.source_class_count,
      input.activity.observation_count,
      input.firstObservedTime,
      input.lastObservedTime,
      input.firstObservedDate,
      input.lastObservedDate,
      input.observationSpanSeconds,
      input.job.policy_revision_id,
      fingerprint,
      previous?.current_revision_id ?? null,
    ],
  );
  const revisionId = inserted.rows[0]?.id;
  if (!revisionId) throw new Error("NODE-7 convergence revision insert failed");

  await input.client.query(
    `INSERT INTO convergence_finding_inputs(finding_revision_id,activity_bucket_revision_id)
     VALUES ($1,$2)`,
    [revisionId, input.activity.id],
  );

  await input.client.query(
    `INSERT INTO convergence_finding_heads(
       finding_key,current_revision_id,state,finding_type,entity_type,entity_key,resolution,
       window_start,window_end,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (finding_key) DO UPDATE SET
       current_revision_id=EXCLUDED.current_revision_id,
       state=EXCLUDED.state,
       finding_type=EXCLUDED.finding_type,
       entity_type=EXCLUDED.entity_type,
       entity_key=EXCLUDED.entity_key,
       resolution=EXCLUDED.resolution,
       window_start=EXCLUDED.window_start,
       window_end=EXCLUDED.window_end,
       updated_at=now()`,
    [
      key,
      revisionId,
      input.state,
      input.findingType,
      input.job.subject_type,
      input.job.subject_key,
      input.job.resolution,
      input.job.window_start.toISOString(),
      input.job.window_end.toISOString(),
    ],
  );
}

async function recomputeConvergence(client: PoolClient, job: ConvergenceJobRow): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `node7:convergence:${job.subject_type}:${job.subject_key}:${job.resolution}:${job.window_start.toISOString()}`,
  ]);

  const activityResult = await client.query<ActivityRevisionRow>(
    `SELECT id,state,observation_count,source_definition_count,upstream_origin_count,
            source_class_count,instant_observation_count,date_observation_count
     FROM entity_activity_bucket_revisions WHERE id=$1`,
    [job.trigger_activity_bucket_revision_id],
  );
  const activity = activityResult.rows[0];
  if (!activity) throw new Error("NODE-7 convergence activity input missing");

  const observationTimes = await client.query<ObservationTimeRow>(
    `SELECT observation.time_precision,observation.observed_time,observation.observed_date::text
     FROM entity_activity_bucket_inputs input
     JOIN entity_observation_revisions observation ON observation.id=input.entity_observation_revision_id
     WHERE input.bucket_revision_id=$1
     ORDER BY COALESCE(observation.observed_time,observation.observed_date::timestamptz), observation.id`,
    [activity.id],
  );
  const rows = observationTimes.rows;
  const allInstant = rows.length > 0 && rows.every((row) => row.time_precision === "INSTANT");
  const allDate = rows.length > 0 && rows.every((row) => row.time_precision === "DATE");
  const timePrecision: "INSTANT" | "DATE" | "MIXED" = allInstant ? "INSTANT" : allDate ? "DATE" : "MIXED";

  const instants = rows.flatMap((row) => row.observed_time ? [row.observed_time] : []).sort((a, b) => a.getTime() - b.getTime());
  const dates = rows.flatMap((row) => row.observed_date ? [row.observed_date] : []).sort();
  const firstObservedTime = allInstant ? instants[0]?.toISOString() ?? null : null;
  const lastObservedTime = allInstant ? instants.at(-1)?.toISOString() ?? null : null;
  const firstObservedDate = allDate ? dates[0] ?? null : null;
  const lastObservedDate = allDate ? dates.at(-1) ?? null : null;
  const observationSpanSeconds = allInstant && instants[0] && instants.at(-1)
    ? Math.max(0, Math.floor(((instants.at(-1) as Date).getTime() - instants[0].getTime()) / 1_000))
    : null;

  const policy = await client.query<{ config: unknown }>(
    `SELECT revision.config FROM node7_derivation_policy_revisions revision WHERE revision.id=$1`,
    [job.policy_revision_id],
  );
  const config = policy.rows[0]?.config;
  const concurrentWindowValue = typeof config === "object" && config !== null && !Array.isArray(config)
    ? (config as Record<string, unknown>).concurrentWindowHours
    : undefined;
  const concurrentWindowHours = typeof concurrentWindowValue === "number" && Number.isFinite(concurrentWindowValue)
    ? concurrentWindowValue
    : 6;

  const classification = activity.state === "ACTIVE"
    ? classifyNode7Convergence({
        sourceDefinitionCount: activity.source_definition_count,
        upstreamOriginCount: activity.upstream_origin_count,
        sourceClassCount: activity.source_class_count,
        timePrecision: timePrecision === "INSTANT" ? "INSTANT" : "DATE",
        observationSpanSeconds,
        concurrentWindowSeconds: Math.round(concurrentWindowHours * 3_600),
      })
    : { findingTypes: [] as Node7FindingType[], concurrentEligible: false };
  const expected = new Set(classification.findingTypes);
  const allTypes: Node7FindingType[] = [
    "SOURCE_SYSTEM_OVERLAP",
    "MULTI_ORIGIN_CONVERGENCE",
    "CROSS_CLASS_CONVERGENCE",
    "CONCURRENT_MOVEMENT",
  ];

  for (const findingType of allTypes) {
    const key = findingKey({
      findingType,
      entityType: job.subject_type,
      entityKey: job.subject_key,
      resolution: job.resolution,
      windowStart: job.window_start.toISOString(),
      policyRevisionId: job.policy_revision_id,
    });
    const current = await client.query<{ state: "ACTIVE" | "RETRACTED" }>(
      `SELECT state FROM convergence_finding_heads WHERE finding_key=$1`,
      [key],
    );
    const shouldBeActive = expected.has(findingType);
    if (!shouldBeActive && current.rows[0]?.state !== "ACTIVE") continue;
    await appendFindingRevision({
      client,
      job,
      activity,
      findingType,
      state: shouldBeActive ? "ACTIVE" : "RETRACTED",
      timePrecision,
      firstObservedTime,
      lastObservedTime,
      firstObservedDate,
      lastObservedDate,
      observationSpanSeconds,
    });
  }

  await client.query(
    `INSERT INTO convergence_projection_receipts(activity_bucket_revision_id,policy_revision_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [activity.id, job.policy_revision_id],
  );
  await client.query(
    `UPDATE node7_projection_jobs
     SET state='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now()
     WHERE id=$1`,
    [job.id],
  );
}

export async function processNextConvergenceJob(workerId: string): Promise<boolean> {
  if (!workerId.trim()) throw new Error("NODE-7 convergence worker requires a worker id");
  return withTransaction(async (client) => {
    const job = await claimConvergenceJob(client, workerId);
    if (!job) return false;
    try {
      await recomputeConvergence(client, job);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown NODE-7 convergence error";
      await client.query(
        `UPDATE node7_projection_jobs
         SET state='FAILED',lease_owner=NULL,lease_expires_at=NULL,
             available_at=now()+interval '30 seconds',failure_code='CONVERGENCE_PROJECTION_FAILED',
             failure_message=$2,finished_at=now(),updated_at=now()
         WHERE id=$1`,
        [job.id, message],
      );
      return false;
    }
  });
}

export async function processNode7ConvergenceBatch(input: {
  workerId: string;
  queueLimit?: number;
  processLimit?: number;
}): Promise<{ queued: number; processed: number }> {
  const queued = await queuePendingConvergenceJobs(input.queueLimit ?? 500);
  const processLimit = input.processLimit ?? 100;
  if (!Number.isInteger(processLimit) || processLimit < 1 || processLimit > 1_000) throw new Error("Invalid NODE-7 convergence process limit");
  let processed = 0;
  for (let index = 0; index < processLimit; index += 1) {
    if (!(await processNextConvergenceJob(input.workerId))) break;
    processed += 1;
  }
  return { queued, processed };
}

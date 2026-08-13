import type { PoolClient } from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { safeFailureMessage } from "../../runtime/failure.js";
import { retryDelaySeconds } from "../../runtime/retry.js";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";
import { measurementConfig } from "../config.js";
import { bucketForInstant, enumerateBuckets } from "../time.js";
import {
  evaluateScheduledCoverage,
  type CoverageEvaluation,
  type CoverageRunInput,
  type ScheduleOrigin,
  type ScheduleRevisionInput,
} from "./schedule.js";
import { createHash } from "node:crypto";

interface CoverageJob {
  id: string;
  collectionRunId: string;
  sourceDefinitionId: string;
  sourceKey: string;
  runState: "SUCCEEDED" | "FAILED" | "PARTIAL" | "CANCELLED";
  trigger: string;
  purpose: string;
  scheduledFor: Date | null;
  runCreatedAt: Date;
  runFinishedAt: Date | null;
  attemptCount: number;
}

interface DirtyCoverageBucket {
  sourceDefinitionId: string;
  sourceKey: string;
  granularity: "FIVE_MINUTES" | "HOUR" | "DAY";
  bucketStart: Date;
  bucketEnd: Date;
  dirtyRevision: string;
}

interface ScheduleRow {
  id: string;
  effective_from: Date;
  effective_to: Date | null;
  enabled: boolean;
  poll_interval_seconds: number | null;
  cadence_anchor_at: Date | null;
  coverage_grace_seconds: number;
  origin_status: ScheduleOrigin;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function acquisitionBasis(trigger: string, purpose: string): string {
  if (purpose === "INITIAL_BOOTSTRAP") return "INITIAL_BOOTSTRAP";
  if (purpose === "HISTORICAL_BACKFILL") return "HISTORICAL_BACKFILL";
  if (purpose === "RESYNC") return "RESYNC";
  if (purpose === "REPAIR") return "REPAIR";
  if (trigger === "RECOVERY") return "RECOVERY";
  return "LIVE_INCREMENTAL";
}

function availabilityForState(state: CoverageJob["runState"]): "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" {
  if (state === "SUCCEEDED") return "AVAILABLE";
  if (state === "PARTIAL") return "PARTIAL";
  return "UNAVAILABLE";
}

function recoveryStatusForState(state: CoverageJob["runState"]): "COMPLETE" | "PARTIAL" | "UNRECOVERABLE" {
  if (state === "SUCCEEDED") return "COMPLETE";
  if (state === "PARTIAL") return "PARTIAL";
  return "UNRECOVERABLE";
}

async function markCoverageBucketDirty(
  client: PoolClient,
  sourceDefinitionId: string,
  instant: Date,
  reason: string,
): Promise<void> {
  for (const granularity of ["FIVE_MINUTES", "HOUR", "DAY"] as const) {
    const bucket = bucketForInstant(instant, granularity);
    await client.query(
      `INSERT INTO source_coverage_dirty_buckets(
         source_definition_id,granularity,bucket_start,bucket_end,
         dirty_revision,dirty_reasons
       ) VALUES ($1,$2,$3,$4,1,jsonb_build_array($5::text))
       ON CONFLICT (source_definition_id,granularity,bucket_start)
       DO UPDATE SET
         bucket_end=EXCLUDED.bucket_end,
         dirty_revision=source_coverage_dirty_buckets.dirty_revision+1,
         dirty_reasons=source_coverage_dirty_buckets.dirty_reasons||EXCLUDED.dirty_reasons,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=now()`,
      [sourceDefinitionId, granularity, bucket.start, bucket.end, reason],
    );
  }
}

async function markMeasurementBucketsForCoverage(
  client: PoolClient,
  sourceKey: string,
  bucket: Pick<DirtyCoverageBucket, "granularity" | "bucketStart" | "bucketEnd">,
): Promise<void> {
  await client.query(
    `INSERT INTO measurement_dirty_buckets(
       measurement_calculation_id,granularity,bucket_start,bucket_end,
       scope_key,dirty_revision,dirty_reasons
     )
     SELECT heads.active_calculation_id,$2,$3,$4,'GLOBAL',1,
            '["COVERAGE_CHANGED"]'::jsonb
     FROM measurement_definition_heads heads
     JOIN measurement_definitions definition ON definition.id=heads.active_definition_id
     WHERE definition.source_scope ? $1
       AND definition.supported_granularities ? $2
     ON CONFLICT (measurement_calculation_id,granularity,bucket_start,scope_key)
     DO UPDATE SET
       bucket_end=EXCLUDED.bucket_end,
       dirty_revision=measurement_dirty_buckets.dirty_revision+1,
       dirty_reasons=measurement_dirty_buckets.dirty_reasons||EXCLUDED.dirty_reasons,
       lease_owner=NULL,lease_expires_at=NULL,updated_at=now()`,
    [sourceKey, bucket.granularity, bucket.bucketStart, bucket.bucketEnd],
  );
}

export async function discoverCoverageJobs(limit = 250): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Invalid coverage discovery limit");
  }

  const result = await pool.query(
    `INSERT INTO coverage_reconciliation_jobs(
       collection_run_id,source_definition_id,state
     )
     SELECT run.id,run.source_definition_id,'QUEUED'
     FROM collection_runs run
     WHERE run.state IN ('SUCCEEDED','FAILED','PARTIAL','CANCELLED')
       AND NOT EXISTS (
         SELECT 1 FROM coverage_reconciliation_jobs existing
         WHERE existing.collection_run_id=run.id
       )
     ORDER BY run.created_at
     LIMIT $1
     ON CONFLICT (collection_run_id) DO NOTHING`,
    [limit],
  );
  return result.rowCount ?? 0;
}

async function claimCoverageJob(workerId: string): Promise<CoverageJob | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      collection_run_id: string;
      source_definition_id: string;
      source_key: string;
      run_state: CoverageJob["runState"];
      trigger: string;
      purpose: string;
      scheduled_for: Date | null;
      run_created_at: Date;
      run_finished_at: Date | null;
      attempt_count: number;
    }>(
      `SELECT job.id,job.collection_run_id,job.source_definition_id,
              source.source_key,run.state AS run_state,run.trigger,run.purpose,
              run.scheduled_for,run.created_at AS run_created_at,
              run.finished_at AS run_finished_at,job.attempt_count
       FROM coverage_reconciliation_jobs job
       JOIN collection_runs run ON run.id=job.collection_run_id
       JOIN source_definitions source ON source.id=job.source_definition_id
       WHERE (job.state='QUEUED' AND job.available_at<=now())
          OR (job.state='RUNNING' AND job.lease_expires_at<now())
       ORDER BY job.created_at
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1`,
    );

    const row = selected.rows[0];
    if (!row) return null;

    const claimed = await client.query<{ attempt_count: number }>(
      `UPDATE coverage_reconciliation_jobs
       SET state='RUNNING',attempt_count=attempt_count+1,
           started_at=COALESCE(started_at,now()),lease_owner=$2,
           lease_expires_at=now()+($3::text||' seconds')::interval,
           updated_at=now()
       WHERE id=$1
       RETURNING attempt_count`,
      [row.id, workerId, measurementConfig.leaseSeconds],
    );

    return {
      id: row.id,
      collectionRunId: row.collection_run_id,
      sourceDefinitionId: row.source_definition_id,
      sourceKey: row.source_key,
      runState: row.run_state,
      trigger: row.trigger,
      purpose: row.purpose,
      scheduledFor: row.scheduled_for,
      runCreatedAt: row.run_created_at,
      runFinishedAt: row.run_finished_at,
      attemptCount: claimed.rows[0]?.attempt_count ?? row.attempt_count + 1,
    };
  });
}

async function insertAcquisitionWindows(client: PoolClient, job: CoverageJob): Promise<void> {
  const basis = acquisitionBasis(job.trigger, job.purpose);
  const availability = availabilityForState(job.runState);
  const recovery = recoveryStatusForState(job.runState);
  const end = job.runFinishedAt ?? job.runCreatedAt;

  if (job.sourceKey === "NVD_CVE") {
    const units = await client.query<{
      id: string;
      state: string;
      descriptor: unknown;
    }>(
      `SELECT id,state,descriptor
       FROM collection_work_units
       WHERE run_id=$1
       ORDER BY ordinal`,
      [job.collectionRunId],
    );

    for (const unit of units.rows) {
      if (!unit.descriptor || typeof unit.descriptor !== "object") continue;
      const descriptor = unit.descriptor as Record<string, unknown>;
      const start = typeof descriptor.windowStart === "string" ? descriptor.windowStart : null;
      const windowEnd = typeof descriptor.windowEnd === "string" ? descriptor.windowEnd : null;
      if (!start || !windowEnd) continue;
      const unitAvailability = unit.state === "SUCCEEDED"
        ? "AVAILABLE"
        : unit.state === "FAILED" || unit.state === "CANCELLED"
          ? "UNAVAILABLE"
          : "PARTIAL";
      const fingerprint = sha256({
        source: job.sourceKey,
        run: job.collectionRunId,
        workUnit: unit.id,
        state: unit.state,
        start,
        end: windowEnd,
        basis,
      });
      await client.query(
        `INSERT INTO source_acquisition_windows(
           source_definition_id,collection_run_id,window_key,projection_version,
           window_kind,time_axis,window_start,window_end,availability_status,
           acquisition_basis,recovery_status,recovery_gap_exceeded,
           population_profile,input_fingerprint
         ) VALUES (
           $1,$2,$3,'node3-coverage-v1','INTERVAL','UPSTREAM_UPDATED_TIME',
           $4,$5,$6,$7,$8,false,NULL,$9
         )
         ON CONFLICT (source_definition_id,collection_run_id,window_key,projection_version)
         DO NOTHING`,
        [
          job.sourceDefinitionId,
          job.collectionRunId,
          `nvd:${unit.id}:${start}:${windowEnd}`,
          start,
          windowEnd,
          unitAvailability,
          basis,
          unitAvailability === "AVAILABLE" ? "COMPLETE" : unitAvailability === "PARTIAL" ? "PARTIAL" : "UNRECOVERABLE",
          fingerprint,
        ],
      );
    }
    return;
  }

  if (job.sourceKey === "FIRST_EPSS") {
    const manifests = await client.query<{ dataset_date: string }>(
      `SELECT DISTINCT payload->>'datasetDate' AS dataset_date
       FROM raw_source_records
       WHERE collection_run_id=$1
         AND payload->>'kind'='EPSS_DATASET_MANIFEST'
         AND payload ? 'datasetDate'`,
      [job.collectionRunId],
    );
    for (const manifest of manifests.rows) {
      const fingerprint = sha256({
        source: job.sourceKey,
        run: job.collectionRunId,
        datasetDate: manifest.dataset_date,
        availability,
        basis,
      });
      await client.query(
        `INSERT INTO source_acquisition_windows(
           source_definition_id,collection_run_id,window_key,projection_version,
           window_kind,time_axis,dataset_date,availability_status,
           acquisition_basis,recovery_status,recovery_gap_exceeded,
           population_profile,input_fingerprint
         ) VALUES (
           $1,$2,$3,'node3-coverage-v1','DATASET_DATE','SOURCE_DATASET_DATE',
           $4::date,$5,$6,$7,false,
           '{"key":"EPSS_HIGH_SIGNAL_V1"}'::jsonb,$8
         )
         ON CONFLICT (source_definition_id,collection_run_id,window_key,projection_version)
         DO NOTHING`,
        [
          job.sourceDefinitionId,
          job.collectionRunId,
          `epss:${manifest.dataset_date}`,
          manifest.dataset_date,
          availability,
          basis,
          recovery,
          fingerprint,
        ],
      );
    }
    return;
  }

  if (job.sourceKey === "THREATFOX" || job.sourceKey === "MALWAREBAZAAR") {
    const horizonMs = job.sourceKey === "THREATFOX"
      ? 7 * 24 * 60 * 60 * 1_000
      : 60 * 60 * 1_000;
    const start = new Date(end.getTime() - horizonMs);
    const fingerprint = sha256({
      source: job.sourceKey,
      run: job.collectionRunId,
      start: start.toISOString(),
      end: end.toISOString(),
      availability,
      basis,
    });
    await client.query(
      `INSERT INTO source_acquisition_windows(
         source_definition_id,collection_run_id,window_key,projection_version,
         window_kind,time_axis,window_start,window_end,availability_status,
         acquisition_basis,recovery_status,recovery_gap_exceeded,
         population_profile,input_fingerprint
       ) VALUES (
         $1,$2,$3,'node3-coverage-v1','INTERVAL','SOURCE_EFFECTIVE_TIME',
         $4,$5,$6,$7,$8,false,NULL,$9
       )
       ON CONFLICT (source_definition_id,collection_run_id,window_key,projection_version)
       DO NOTHING`,
      [
        job.sourceDefinitionId,
        job.collectionRunId,
        `${job.sourceKey.toLowerCase()}:${start.toISOString()}:${end.toISOString()}`,
        start,
        end,
        availability,
        basis,
        recovery,
        fingerprint,
      ],
    );
    return;
  }

  if (job.sourceKey === "CISA_KEV") {
    const fingerprint = sha256({
      source: job.sourceKey,
      run: job.collectionRunId,
      confirmedAt: end.toISOString(),
      availability,
      basis,
    });
    await client.query(
      `INSERT INTO source_acquisition_windows(
         source_definition_id,collection_run_id,window_key,projection_version,
         window_kind,time_axis,availability_status,acquisition_basis,
         recovery_status,recovery_gap_exceeded,population_profile,input_fingerprint
       ) VALUES (
         $1,$2,$3,'node3-coverage-v1','SNAPSHOT','NODE_RECEIVED_TIME',
         $4,$5,$6,false,NULL,$7
       )
       ON CONFLICT (source_definition_id,collection_run_id,window_key,projection_version)
       DO NOTHING`,
      [
        job.sourceDefinitionId,
        job.collectionRunId,
        `cisa:${job.collectionRunId}`,
        availability,
        basis,
        recovery,
        fingerprint,
      ],
    );
  }
}

async function persistCoverageJobSuccess(job: CoverageJob, workerId: string): Promise<void> {
  await withTransaction(async (client) => {
    const lease = await client.query(
      `SELECT 1
       FROM coverage_reconciliation_jobs
       WHERE id=$1 AND state='RUNNING' AND lease_owner=$2
       FOR UPDATE`,
      [job.id, workerId],
    );
    if (!lease.rowCount) return;

    await insertAcquisitionWindows(client, job);
    const instant = job.scheduledFor ?? job.runFinishedAt ?? job.runCreatedAt;
    await markCoverageBucketDirty(client, job.sourceDefinitionId, instant, "COLLECTION_RUN_TERMINAL");

    await client.query(
      `UPDATE coverage_reconciliation_jobs
       SET state='SUCCEEDED',finished_at=now(),lease_owner=NULL,
           lease_expires_at=NULL,failure_code=NULL,failure_message=NULL,updated_at=now()
       WHERE id=$1`,
      [job.id],
    );
  });
}

async function persistCoverageJobFailure(
  job: CoverageJob,
  workerId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await withTransaction(async (client) => {
    const lease = await client.query(
      `SELECT 1
       FROM coverage_reconciliation_jobs
       WHERE id=$1 AND state='RUNNING' AND lease_owner=$2
       FOR UPDATE`,
      [job.id, workerId],
    );
    if (!lease.rowCount) return;

    const retry = job.attemptCount < measurementConfig.maxAttempts;
    const delay = retry
      ? retryDelaySeconds({ attemptCount: job.attemptCount, baseSeconds: 5, maxSeconds: 300 })
      : 0;

    await client.query(
      `UPDATE coverage_reconciliation_jobs
       SET state=$2,
           available_at=CASE WHEN $2='QUEUED'
             THEN now()+($4::int*interval '1 second') ELSE available_at END,
           lease_owner=NULL,lease_expires_at=NULL,
           finished_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,
           failure_code='COVERAGE_RECONCILIATION_ERROR',failure_message=$3,updated_at=now()
       WHERE id=$1`,
      [job.id, retry ? "QUEUED" : "FAILED", safeFailureMessage(message), delay],
    );
  });
}

export async function reconcileCoverageJobTick(workerId: string): Promise<boolean> {
  const job = await claimCoverageJob(workerId);
  if (!job) return false;
  try {
    await persistCoverageJobSuccess(job, workerId);
  } catch (error) {
    await persistCoverageJobFailure(job, workerId, error);
  }
  return true;
}

export async function discoverCoverageBuckets(
  evaluatedAt = new Date(),
  limit = 1_000,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("Invalid coverage bucket discovery limit");
  }

  const sources = await pool.query<{
    source_definition_id: string;
    earliest_schedule_at: Date;
    evaluated_through: Date | null;
  }>(
    `SELECT source.id AS source_definition_id,
            MIN(schedule.effective_from) AS earliest_schedule_at,
            state.evaluated_through
     FROM source_definitions source
     JOIN source_schedule_revisions schedule ON schedule.source_definition_id=source.id
     LEFT JOIN source_coverage_reconciliation_state state ON state.source_definition_id=source.id
     GROUP BY source.id,state.evaluated_through
     ORDER BY MIN(schedule.effective_from)`,
  );

  let inserted = 0;
  for (const source of sources.rows) {
    if (inserted >= limit) break;
    const start = source.evaluated_through ?? source.earliest_schedule_at;
    if (start >= evaluatedAt) continue;

    let maxEnd = start;
    for (const granularity of ["FIVE_MINUTES", "HOUR", "DAY"] as const) {
      const remaining = limit - inserted;
      if (remaining <= 0) break;
      const buckets = enumerateBuckets({
        from: start.toISOString(),
        to: evaluatedAt.toISOString(),
        granularity,
        maxBuckets: Math.min(remaining, 10_000),
      });
      for (const bucket of buckets) {
        const result = await pool.query(
          `INSERT INTO source_coverage_dirty_buckets(
             source_definition_id,granularity,bucket_start,bucket_end,
             dirty_revision,dirty_reasons
           ) VALUES ($1,$2,$3,$4,1,'["SCHEDULE_RECONCILIATION"]'::jsonb)
           ON CONFLICT (source_definition_id,granularity,bucket_start)
           DO NOTHING`,
          [source.source_definition_id, granularity, bucket.start, bucket.end],
        );
        inserted += result.rowCount ?? 0;
        const end = new Date(bucket.end);
        if (end > maxEnd) maxEnd = end;
        if (inserted >= limit) break;
      }
    }

    if (maxEnd > start) {
      await pool.query(
        `UPDATE source_coverage_reconciliation_state
         SET evaluated_through=$2,updated_at=now()
         WHERE source_definition_id=$1`,
        [source.source_definition_id, maxEnd],
      );
    }
  }

  return inserted;
}

async function claimDirtyCoverageBucket(workerId: string): Promise<DirtyCoverageBucket | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      source_definition_id: string;
      source_key: string;
      granularity: DirtyCoverageBucket["granularity"];
      bucket_start: Date;
      bucket_end: Date;
      dirty_revision: string;
    }>(
      `SELECT dirty.source_definition_id,source.source_key,dirty.granularity,
              dirty.bucket_start,dirty.bucket_end,dirty.dirty_revision::text
       FROM source_coverage_dirty_buckets dirty
       JOIN source_definitions source ON source.id=dirty.source_definition_id
       WHERE dirty.lease_expires_at IS NULL OR dirty.lease_expires_at<now()
       ORDER BY dirty.dirty_since
       FOR UPDATE OF dirty SKIP LOCKED
       LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) return null;

    await client.query(
      `UPDATE source_coverage_dirty_buckets
       SET lease_owner=$5,
           lease_expires_at=now()+($6::text||' seconds')::interval,
           updated_at=now()
       WHERE source_definition_id=$1 AND granularity=$2
         AND bucket_start=$3 AND dirty_revision=$4::bigint`,
      [
        row.source_definition_id,
        row.granularity,
        row.bucket_start,
        row.dirty_revision,
        workerId,
        measurementConfig.leaseSeconds,
      ],
    );

    return {
      sourceDefinitionId: row.source_definition_id,
      sourceKey: row.source_key,
      granularity: row.granularity,
      bucketStart: row.bucket_start,
      bucketEnd: row.bucket_end,
      dirtyRevision: row.dirty_revision,
    };
  });
}

function scheduleInput(row: ScheduleRow): ScheduleRevisionInput {
  return {
    effectiveFrom: row.effective_from.toISOString(),
    effectiveTo: row.effective_to?.toISOString() ?? null,
    enabled: row.enabled,
    pollIntervalSeconds: row.poll_interval_seconds,
    cadenceAnchorAt: row.cadence_anchor_at?.toISOString() ?? null,
    coverageGraceSeconds: row.coverage_grace_seconds,
    originStatus: row.origin_status,
  };
}

function combineEvaluations(
  segments: readonly { schedule: ScheduleRow; evaluation: CoverageEvaluation }[],
): CoverageEvaluation & { scheduleOrigin: ScheduleOrigin } {
  if (segments.length === 0) {
    const empty: CoverageEvaluation = {
      expectationStatus: "UNKNOWN",
      coverageStatus: "NO_COVERAGE",
      evaluationState: "FINAL",
      expectedOpportunityCount: 0,
      satisfiedOpportunityCount: 0,
      partialOpportunityCount: 0,
      failedOpportunityCount: 0,
      missingOpportunityCount: 0,
      opportunities: [],
      reasonCodes: ["SCHEDULE_HISTORY_UNAVAILABLE"],
      inputFingerprint: sha256({ segments: [] }),
    };
    return { ...empty, scheduleOrigin: "UNKNOWN" };
  }

  const expected = segments.filter((segment) => segment.evaluation.expectationStatus === "EXPECTED");
  const hasUnknown = segments.some((segment) => segment.evaluation.expectationStatus === "UNKNOWN");
  const expectationStatus = expected.length > 0
    ? "EXPECTED"
    : hasUnknown
      ? "UNKNOWN"
      : "NOT_EXPECTED";

  let coverageStatus: CoverageEvaluation["coverageStatus"] = "NO_COVERAGE";
  if (expected.length > 0) {
    if (expected.every((segment) => segment.evaluation.coverageStatus === "COMPLETE") && !hasUnknown) {
      coverageStatus = "COMPLETE";
    } else if (expected.some((segment) => ["COMPLETE", "PARTIAL"].includes(segment.evaluation.coverageStatus))) {
      coverageStatus = "PARTIAL";
    } else if (expected.some((segment) => segment.evaluation.coverageStatus === "DEGRADED")) {
      coverageStatus = "DEGRADED";
    }
  }

  const origins = [...new Set(segments.map((segment) => segment.schedule.origin_status))];
  const scheduleOrigin: ScheduleOrigin = origins.length === 1 ? origins[0] ?? "UNKNOWN" : "UNKNOWN";
  const opportunities = segments.flatMap((segment) => segment.evaluation.opportunities);
  const reasonCodes = [...new Set(segments.flatMap((segment) => segment.evaluation.reasonCodes))].sort();
  const evaluationState = segments.some((segment) => segment.evaluation.evaluationState === "PROVISIONAL")
    ? "PROVISIONAL"
    : "FINAL";

  return {
    expectationStatus,
    coverageStatus,
    evaluationState,
    expectedOpportunityCount: segments.reduce((sum, segment) => sum + segment.evaluation.expectedOpportunityCount, 0),
    satisfiedOpportunityCount: segments.reduce((sum, segment) => sum + segment.evaluation.satisfiedOpportunityCount, 0),
    partialOpportunityCount: segments.reduce((sum, segment) => sum + segment.evaluation.partialOpportunityCount, 0),
    failedOpportunityCount: segments.reduce((sum, segment) => sum + segment.evaluation.failedOpportunityCount, 0),
    missingOpportunityCount: segments.reduce((sum, segment) => sum + segment.evaluation.missingOpportunityCount, 0),
    opportunities,
    reasonCodes,
    inputFingerprint: sha256(
      segments.map((segment) => ({
        scheduleId: segment.schedule.id,
        fingerprint: segment.evaluation.inputFingerprint,
      })),
    ),
    scheduleOrigin,
  };
}

async function evaluateCoverageBucket(bucket: DirtyCoverageBucket): Promise<ReturnType<typeof combineEvaluations>> {
  const schedules = await pool.query<ScheduleRow>(
    `WITH history AS (
       SELECT revision.*,
              LEAD(revision.effective_from) OVER (
                PARTITION BY revision.source_definition_id
                ORDER BY revision.effective_from,revision.created_at,revision.id
              ) AS effective_to
       FROM source_schedule_revisions revision
       WHERE revision.source_definition_id=$1
     )
     SELECT id,effective_from,effective_to,enabled,poll_interval_seconds,
            cadence_anchor_at,coverage_grace_seconds,origin_status
     FROM history
     WHERE effective_from<$3
       AND (effective_to IS NULL OR effective_to>$2)
     ORDER BY effective_from`,
    [bucket.sourceDefinitionId, bucket.bucketStart, bucket.bucketEnd],
  );

  const maxGraceSeconds = schedules.rows.reduce(
    (maximum, schedule) => Math.max(maximum, schedule.coverage_grace_seconds),
    60,
  );
  const runs = await pool.query<{
    id: string;
    scheduled_for: Date | null;
    trigger: string;
    purpose: string;
    state: string;
  }>(
    `SELECT id,scheduled_for,trigger,purpose,state
     FROM collection_runs
     WHERE source_definition_id=$1
       AND scheduled_for IS NOT NULL
       AND scheduled_for >= $2::timestamptz - ($4::text||' seconds')::interval
       AND scheduled_for < $3::timestamptz + ($4::text||' seconds')::interval
     ORDER BY scheduled_for,created_at`,
    [bucket.sourceDefinitionId, bucket.bucketStart, bucket.bucketEnd, maxGraceSeconds],
  );

  const runInputs: CoverageRunInput[] = runs.rows.map((run) => ({
    id: run.id,
    scheduledFor: run.scheduled_for?.toISOString() ?? null,
    trigger: run.trigger,
    purpose: run.purpose,
    state: run.state,
  }));
  const evaluatedAt = new Date().toISOString();
  const segments = schedules.rows.map((schedule) => ({
    schedule,
    evaluation: evaluateScheduledCoverage({
      bucketStart: bucket.bucketStart.toISOString(),
      bucketEnd: bucket.bucketEnd.toISOString(),
      evaluatedAt,
      schedule: scheduleInput(schedule),
      runs: runInputs,
    }),
  }));
  return combineEvaluations(segments);
}

export async function coverageAggregationTick(workerId: string): Promise<boolean> {
  const bucket = await claimDirtyCoverageBucket(workerId);
  if (!bucket) return false;
  const evaluation = await evaluateCoverageBucket(bucket);

  await withTransaction(async (client) => {
    const dirty = await client.query(
      `SELECT 1
       FROM source_coverage_dirty_buckets
       WHERE source_definition_id=$1 AND granularity=$2 AND bucket_start=$3
         AND dirty_revision=$4::bigint AND lease_owner=$5
       FOR UPDATE`,
      [
        bucket.sourceDefinitionId,
        bucket.granularity,
        bucket.bucketStart,
        bucket.dirtyRevision,
        workerId,
      ],
    );
    if (!dirty.rowCount) return;

    const head = await client.query<{
      current_revision_id: string;
      revision_number: number;
      input_fingerprint: string;
    }>(
      `SELECT head.current_revision_id,revision.revision_number,revision.input_fingerprint
       FROM source_coverage_bucket_heads head
       JOIN source_coverage_bucket_revisions revision ON revision.id=head.current_revision_id
       WHERE head.source_definition_id=$1 AND head.granularity=$2 AND head.bucket_start=$3
       FOR UPDATE OF head`,
      [bucket.sourceDefinitionId, bucket.granularity, bucket.bucketStart],
    );
    const prior = head.rows[0];

    if (!prior || prior.input_fingerprint !== evaluation.inputFingerprint) {
      const state = evaluation.evaluationState === "PROVISIONAL"
        ? "PROVISIONAL"
        : prior
          ? "REVISED"
          : "FINAL";
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO source_coverage_bucket_revisions(
           source_definition_id,granularity,bucket_start,bucket_end,
           expectation_status,coverage_status,evaluation_state,
           expected_opportunity_count,satisfied_opportunity_count,
           partial_opportunity_count,failed_opportunity_count,missing_opportunity_count,
           schedule_origin,reason_codes,input_fingerprint,revision_number,
           supersedes_revision_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17
         ) RETURNING id`,
        [
          bucket.sourceDefinitionId,
          bucket.granularity,
          bucket.bucketStart,
          bucket.bucketEnd,
          evaluation.expectationStatus,
          evaluation.coverageStatus,
          state,
          evaluation.expectedOpportunityCount,
          evaluation.satisfiedOpportunityCount,
          evaluation.partialOpportunityCount,
          evaluation.failedOpportunityCount,
          evaluation.missingOpportunityCount,
          evaluation.scheduleOrigin,
          canonicalJsonStringify(evaluation.reasonCodes),
          evaluation.inputFingerprint,
          (prior?.revision_number ?? 0) + 1,
          prior?.current_revision_id ?? null,
        ],
      );
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new Error("Failed to append source coverage revision");

      await client.query(
        `INSERT INTO source_coverage_bucket_heads(
           source_definition_id,granularity,bucket_start,bucket_end,current_revision_id,updated_at
         ) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (source_definition_id,granularity,bucket_start)
         DO UPDATE SET
           bucket_end=EXCLUDED.bucket_end,
           current_revision_id=EXCLUDED.current_revision_id,
           updated_at=now()`,
        [
          bucket.sourceDefinitionId,
          bucket.granularity,
          bucket.bucketStart,
          bucket.bucketEnd,
          revisionId,
        ],
      );

      await markMeasurementBucketsForCoverage(client, bucket.sourceKey, bucket);
    }

    await client.query(
      `DELETE FROM source_coverage_dirty_buckets
       WHERE source_definition_id=$1 AND granularity=$2 AND bucket_start=$3
         AND dirty_revision=$4::bigint AND lease_owner=$5`,
      [
        bucket.sourceDefinitionId,
        bucket.granularity,
        bucket.bucketStart,
        bucket.dirtyRevision,
        workerId,
      ],
    );
  });

  return true;
}

export async function coverageQueueDepth(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT
       (SELECT count(*) FROM coverage_reconciliation_jobs WHERE state IN ('QUEUED','RUNNING'))
       + (SELECT count(*) FROM source_coverage_dirty_buckets) AS count`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

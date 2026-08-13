import { pool } from "../db/pool.js";
import { runNode3FinalAudit } from "../measurement/audit.js";
import { persistBackfillPlan, planBackfill } from "../measurement/backfill.js";
import { publicMeasurementRegistry, syncMeasurementRegistry } from "../measurement/registry.js";
import { enumerateBuckets, parseRfc3339Instant } from "../measurement/time.js";

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function status(): Promise<void> {
  const heartbeat = await pool.query<{ heartbeat_at: Date }>(
    `SELECT heartbeat_at
     FROM runtime_heartbeats
     WHERE component='MEASUREMENT'
     ORDER BY heartbeat_at DESC
     LIMIT 1`,
  );
  const counts = await pool.query<{
    projection_queued: number;
    projection_running: number;
    projection_failed: number;
    coverage_queued: number;
    coverage_running: number;
    coverage_failed: number;
    dirty_measurements: number;
    dirty_coverage: number;
  }>(
    `SELECT
       (SELECT count(*) FROM measurement_projection_jobs WHERE state='QUEUED')::int AS projection_queued,
       (SELECT count(*) FROM measurement_projection_jobs WHERE state='RUNNING')::int AS projection_running,
       (SELECT count(*) FROM measurement_projection_jobs WHERE state='FAILED')::int AS projection_failed,
       (SELECT count(*) FROM coverage_reconciliation_jobs WHERE state='QUEUED')::int AS coverage_queued,
       (SELECT count(*) FROM coverage_reconciliation_jobs WHERE state='RUNNING')::int AS coverage_running,
       (SELECT count(*) FROM coverage_reconciliation_jobs WHERE state='FAILED')::int AS coverage_failed,
       (SELECT count(*) FROM measurement_dirty_buckets)::int AS dirty_measurements,
       (SELECT count(*) FROM source_coverage_dirty_buckets)::int AS dirty_coverage`,
  );

  console.log(JSON.stringify({
    schemaVersion: "NODE3_STATUS_V1",
    measurementHeartbeatAt: heartbeat.rows[0]?.heartbeat_at?.toISOString() ?? null,
    queues: counts.rows[0] ?? null,
  }, null, 2));
}

async function catalog(): Promise<void> {
  await syncMeasurementRegistry();
  console.log(JSON.stringify({
    schemaVersion: "NODE3_MEASUREMENT_CATALOG_V1",
    measurements: publicMeasurementRegistry().map((registration) => ({
      measurementKey: registration.definition.measurementKey,
      contractVersion: registration.definition.contractVersion,
      calculationVersion: registration.calculation.calculationVersion,
      represents: registration.definition.represents,
      doesNotRepresent: registration.definition.doesNotRepresent,
    })),
  }, null, 2));
}

async function measurementRebuild(): Promise<void> {
  const measurementKey = required("--measurement");
  const from = parseRfc3339Instant(required("--from"));
  const to = parseRfc3339Instant(required("--to"));
  if (to <= from) throw new Error("--to must be after --from");

  const head = await pool.query<{ active_calculation_id: string }>(
    `SELECT active_calculation_id
     FROM measurement_definition_heads
     WHERE measurement_key=$1`,
    [measurementKey],
  );
  const calculationId = head.rows[0]?.active_calculation_id;
  if (!calculationId) throw new Error(`Measurement not synchronized: ${measurementKey}`);

  const registration = publicMeasurementRegistry().find(
    (item) => item.definition.measurementKey === measurementKey,
  );
  if (!registration) throw new Error(`Unsupported public measurement: ${measurementKey}`);

  let affectedBuckets = 0;
  for (const granularity of registration.definition.supportedGranularities) {
    const buckets = enumerateBuckets({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      maxBuckets: 5_000,
    });
    for (const bucket of buckets) {
      await pool.query(
        `INSERT INTO measurement_dirty_buckets(
           measurement_calculation_id,granularity,bucket_start,bucket_end,
           scope_key,dirty_revision,dirty_reasons
         ) VALUES ($1,$2,$3,$4,'GLOBAL',1,'["MANUAL_REBUILD"]'::jsonb)
         ON CONFLICT (measurement_calculation_id,granularity,bucket_start,scope_key)
         DO UPDATE SET
           bucket_end=EXCLUDED.bucket_end,
           dirty_revision=measurement_dirty_buckets.dirty_revision+1,
           dirty_reasons=measurement_dirty_buckets.dirty_reasons||EXCLUDED.dirty_reasons,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=now()`,
        [calculationId, granularity, bucket.start, bucket.end],
      );
      affectedBuckets += 1;
    }
  }

  console.log(JSON.stringify({
    schemaVersion: "NODE3_MEASUREMENT_REBUILD_V1",
    measurementKey,
    from: from.toISOString(),
    to: to.toISOString(),
    affectedBuckets,
    note: "This re-aggregates current revisioned facts; semantic projector changes require a new calculation version.",
  }, null, 2));
}

async function coverageRebuild(): Promise<void> {
  const sourceKey = required("--source");
  const from = parseRfc3339Instant(required("--from"));
  const to = parseRfc3339Instant(required("--to"));
  if (to <= from) throw new Error("--to must be after --from");

  const source = await pool.query<{ id: string }>(
    `SELECT id FROM source_definitions WHERE source_key=$1`,
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  if (!sourceDefinitionId) throw new Error(`Source not found: ${sourceKey}`);

  let affectedBuckets = 0;
  for (const granularity of ["FIVE_MINUTES", "HOUR", "DAY"] as const) {
    const buckets = enumerateBuckets({
      from: from.toISOString(),
      to: to.toISOString(),
      granularity,
      maxBuckets: 5_000,
    });
    for (const bucket of buckets) {
      await pool.query(
        `INSERT INTO source_coverage_dirty_buckets(
           source_definition_id,granularity,bucket_start,bucket_end,
           dirty_revision,dirty_reasons
         ) VALUES ($1,$2,$3,$4,1,'["MANUAL_REBUILD"]'::jsonb)
         ON CONFLICT (source_definition_id,granularity,bucket_start)
         DO UPDATE SET
           bucket_end=EXCLUDED.bucket_end,
           dirty_revision=source_coverage_dirty_buckets.dirty_revision+1,
           dirty_reasons=source_coverage_dirty_buckets.dirty_reasons||EXCLUDED.dirty_reasons,
           lease_owner=NULL,lease_expires_at=NULL,updated_at=now()`,
        [sourceDefinitionId, granularity, bucket.start, bucket.end],
      );
      affectedBuckets += 1;
    }
  }

  console.log(JSON.stringify({
    schemaVersion: "NODE3_COVERAGE_REBUILD_V1",
    sourceKey,
    from: from.toISOString(),
    to: to.toISOString(),
    affectedBuckets,
  }, null, 2));
}

async function backfillPlanCommand(): Promise<void> {
  const plan = planBackfill(
    required("--source"),
    required("--from"),
    required("--to"),
  );
  const requestId = option("--persist") === "true"
    ? await persistBackfillPlan(plan)
    : null;
  console.log(JSON.stringify({
    schemaVersion: "NODE3_BACKFILL_PLAN_V1",
    requestId,
    plan,
  }, null, 2));
}

async function backfillStatus(): Promise<void> {
  const rows = await pool.query(
    `SELECT request.id,source.source_key,request.requested_from,request.requested_to,
            request.status,request.backfill_policy_version,
            request.segments_planned,request.segments_completed,request.records_inserted,
            request.failure_code,request.failure_message,request.created_at,
            request.started_at,request.finished_at
     FROM historical_backfill_requests request
     JOIN source_definitions source ON source.id=request.source_definition_id
     ORDER BY request.created_at DESC
     LIMIT 100`,
  );
  console.log(JSON.stringify({
    schemaVersion: "NODE3_BACKFILL_STATUS_V1",
    requests: rows.rows,
  }, null, 2));
}

async function finalAudit(): Promise<void> {
  const result = await runNode3FinalAudit();
  console.log(JSON.stringify(result, null, 2));
  if (!result.accepted) process.exitCode = 1;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  if (command === "status") await status();
  else if (command === "measurement-catalog") await catalog();
  else if (command === "measurement-rebuild") await measurementRebuild();
  else if (command === "coverage-rebuild") await coverageRebuild();
  else if (command === "backfill-plan") await backfillPlanCommand();
  else if (command === "backfill-status") await backfillStatus();
  else if (command === "final-audit") await finalAudit();
  else throw new Error(`Unknown NODE-3 command: ${command}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

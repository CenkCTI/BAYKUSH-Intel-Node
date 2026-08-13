import { pool } from "../src/db/pool.js";
import { applyMeasurementFactCandidate } from "../src/measurement/projection/runtime.js";
import { makeCandidate } from "../src/measurement/projection/utils.js";
import { syncMeasurementRegistry } from "../src/measurement/registry.js";

interface CheckResult {
  check: string;
  accepted: boolean;
  detail?: string;
}

async function run(): Promise<void> {
  if (process.env.NODE3_ACCEPTANCE_CONFIRMED !== "true") {
    throw new Error(
      "Set NODE3_ACCEPTANCE_CONFIRMED=true to run PostgreSQL-backed NODE-3 acceptance",
    );
  }

  await syncMeasurementRegistry();

  const source = await pool.query<{ id: string }>(
    `SELECT id FROM source_definitions WHERE source_key='TEST_SYNTHETIC'`,
  );
  const sourceDefinitionId = source.rows[0]?.id;
  if (!sourceDefinitionId) {
    throw new Error("TEST_SYNTHETIC source definition is required for NODE-3 acceptance");
  }

  const measurement = await pool.query<{ active_calculation_id: string }>(
    `SELECT active_calculation_id
     FROM measurement_definition_heads
     WHERE measurement_key='internal.synthetic.events'`,
  );
  const calculationId = measurement.rows[0]?.active_calculation_id;
  if (!calculationId) {
    throw new Error("internal.synthetic.events must be synchronized before acceptance");
  }

  const client = await pool.connect();
  const checks: CheckResult[] = [];
  try {
    await client.query("BEGIN");

    const first = makeCandidate({
      measurementKey: "internal.synthetic.events",
      identity: { acceptanceIdentity: "NODE3-REVISION-TEST" },
      factKind: "EVENT",
      eventTime: "2026-08-13T10:12:00.000Z",
      eventDate: null,
      timePrecision: "INSTANT",
      numericValue: 1,
      entityKey: "synthetic:node3-acceptance",
      entityType: "SYNTHETIC",
      dimensions: {},
      acquisitionBasis: "LIVE_INCREMENTAL",
      sourceModelVersion: null,
      inputRole: "ACCEPTANCE",
      fingerprintMaterial: { version: 1, time: "2026-08-13T10:12:00.000Z" },
    });
    const revised = makeCandidate({
      measurementKey: "internal.synthetic.events",
      identity: { acceptanceIdentity: "NODE3-REVISION-TEST" },
      factKind: "EVENT",
      eventTime: "2026-08-13T09:58:00.000Z",
      eventDate: null,
      timePrecision: "INSTANT",
      numericValue: 1,
      entityKey: "synthetic:node3-acceptance",
      entityType: "SYNTHETIC",
      dimensions: {},
      acquisitionBasis: "HISTORICAL_BACKFILL",
      sourceModelVersion: null,
      inputRole: "ACCEPTANCE",
      fingerprintMaterial: { version: 2, time: "2026-08-13T09:58:00.000Z" },
    });

    const firstWritten = await applyMeasurementFactCandidate({
      client,
      calculationId,
      sourceDefinitionId,
      candidate: first,
      reason: "NEW_FACT",
    });
    const secondWritten = await applyMeasurementFactCandidate({
      client,
      calculationId,
      sourceDefinitionId,
      candidate: revised,
      reason: "LATE_FACT",
    });
    const duplicateWritten = await applyMeasurementFactCandidate({
      client,
      calculationId,
      sourceDefinitionId,
      candidate: revised,
      reason: "LATE_FACT",
    });

    checks.push({
      check: "first-and-revised-write",
      accepted: firstWritten && secondWritten && !duplicateWritten,
    });

    const revisions = await client.query<{
      revision_number: number;
      event_time: Date;
      supersedes_fact_id: string | null;
    }>(
      `SELECT revision_number,event_time,supersedes_fact_id
       FROM measurement_facts
       WHERE measurement_calculation_id=$1 AND fact_key=$2
       ORDER BY revision_number`,
      [calculationId, first.factKey],
    );
    checks.push({
      check: "immutable-fact-revision-chain",
      accepted:
        revisions.rowCount === 2
        && revisions.rows[0]?.revision_number === 1
        && revisions.rows[1]?.revision_number === 2
        && revisions.rows[1]?.supersedes_fact_id !== null,
      detail: `revisions=${revisions.rowCount ?? 0}`,
    });

    const head = await client.query<{
      fact_state: string;
      event_time: Date;
      current_revision: number;
    }>(
      `SELECT head.fact_state,head.event_time,
              fact.revision_number AS current_revision
       FROM measurement_fact_heads head
       JOIN measurement_facts fact ON fact.id=head.current_fact_id
       WHERE head.measurement_calculation_id=$1 AND head.fact_key=$2`,
      [calculationId, first.factKey],
    );
    checks.push({
      check: "fact-head-points-to-latest-correction",
      accepted:
        head.rows[0]?.fact_state === "ACTIVE"
        && head.rows[0]?.current_revision === 2
        && head.rows[0]?.event_time.toISOString() === "2026-08-13T09:58:00.000Z",
    });

    const dirty = await client.query<{ granularity: string; bucket_start: Date }>(
      `SELECT granularity,bucket_start
       FROM measurement_dirty_buckets
       WHERE measurement_calculation_id=$1
       ORDER BY granularity,bucket_start`,
      [calculationId],
    );
    const dirtyIdentities = new Set(
      dirty.rows.map((row) => `${row.granularity}:${row.bucket_start.toISOString()}`),
    );
    checks.push({
      check: "correction-dirties-old-and-new-time-buckets",
      accepted:
        dirtyIdentities.has("FIVE_MINUTES:2026-08-13T10:10:00.000Z")
        && dirtyIdentities.has("FIVE_MINUTES:2026-08-13T09:55:00.000Z")
        && dirtyIdentities.has("HOUR:2026-08-13T10:00:00.000Z")
        && dirtyIdentities.has("HOUR:2026-08-13T09:00:00.000Z")
        && dirtyIdentities.has("DAY:2026-08-13T00:00:00.000Z"),
    });

    const tableCheck = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM information_schema.tables
       WHERE table_schema=current_schema()
         AND table_name IN (
           'measurement_definitions','measurement_calculation_versions','measurement_facts',
           'measurement_fact_heads','source_schedule_revisions','source_acquisition_windows',
           'source_coverage_bucket_revisions','measurement_bucket_revisions',
           'entity_observation_revisions','entity_history_revisions','historical_backfill_requests'
         )`,
    );
    checks.push({
      check: "node3-schema-present",
      accepted: tableCheck.rows[0]?.count === 11,
      detail: `tables=${tableCheck.rows[0]?.count ?? 0}/11`,
    });

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  const accepted = checks.every((check) => check.accepted);
  console.log(JSON.stringify({
    schemaVersion: "NODE3_MEASUREMENT_ACCEPTANCE_V1",
    accepted,
    checks,
  }, null, 2));
  if (!accepted) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

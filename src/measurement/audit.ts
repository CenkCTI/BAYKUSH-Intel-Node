import { pool } from "../db/pool.js";

export interface Node3AuditDifference {
  invariant: string;
  count: number;
}

export interface Node3FinalAudit {
  schemaVersion: "NODE3_FINAL_AUDIT_V1";
  accepted: boolean;
  differences: Node3AuditDifference[];
}

const checks: readonly [string, string][] = [
  [
    "measurement_definition_head_mismatch",
    `SELECT count(*)::int AS count
     FROM measurement_definition_heads head
     JOIN measurement_calculation_versions calculation
       ON calculation.id=head.active_calculation_id
     WHERE calculation.measurement_definition_id<>head.active_definition_id`,
  ],
  [
    "measurement_fact_head_mismatch",
    `SELECT count(*)::int AS count
     FROM measurement_fact_heads head
     JOIN measurement_facts fact ON fact.id=head.current_fact_id
     WHERE fact.measurement_calculation_id<>head.measurement_calculation_id
        OR fact.fact_key<>head.fact_key
        OR fact.fact_state<>head.fact_state`,
  ],
  [
    "measurement_fact_without_provenance",
    `SELECT count(*)::int AS count
     FROM measurement_facts fact
     WHERE NOT EXISTS (
       SELECT 1 FROM measurement_fact_inputs input
       WHERE input.measurement_fact_id=fact.id
     )`,
  ],
  [
    "measurement_fact_input_exactly_one_violation",
    `SELECT count(*)::int AS count
     FROM measurement_fact_inputs
     WHERE num_nonnulls(
       raw_record_id,canonical_record_id,collection_run_id,entity_history_revision_id
     )<>1`,
  ],
  [
    "measurement_bucket_head_mismatch",
    `SELECT count(*)::int AS count
     FROM measurement_bucket_heads head
     JOIN measurement_bucket_revisions revision ON revision.id=head.current_revision_id
     WHERE revision.measurement_calculation_id<>head.measurement_calculation_id
        OR revision.granularity<>head.granularity
        OR revision.bucket_start<>head.bucket_start
        OR revision.bucket_end<>head.bucket_end
        OR revision.scope_key<>head.scope_key`,
  ],
  [
    "coverage_bucket_head_mismatch",
    `SELECT count(*)::int AS count
     FROM source_coverage_bucket_heads head
     JOIN source_coverage_bucket_revisions revision ON revision.id=head.current_revision_id
     WHERE revision.source_definition_id<>head.source_definition_id
        OR revision.granularity<>head.granularity
        OR revision.bucket_start<>head.bucket_start
        OR revision.bucket_end<>head.bucket_end`,
  ],
  [
    "complete_coverage_count_contradiction",
    `SELECT count(*)::int AS count
     FROM source_coverage_bucket_revisions
     WHERE coverage_status='COMPLETE'
       AND (
         expectation_status<>'EXPECTED'
         OR expected_opportunity_count=0
         OR satisfied_opportunity_count<>expected_opportunity_count
       )`,
  ],
  [
    "entity_observation_head_mismatch",
    `SELECT count(*)::int AS count
     FROM entity_observation_heads head
     JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
     WHERE revision.observation_key<>head.observation_key
        OR revision.entity_key<>head.entity_key
        OR revision.entity_type<>head.entity_type
        OR revision.state<>head.state`,
  ],
  [
    "entity_history_head_mismatch",
    `SELECT count(*)::int AS count
     FROM entity_history_heads head
     JOIN entity_history_revisions revision ON revision.id=head.current_revision_id
     WHERE revision.entity_key<>head.entity_key
        OR revision.entity_type<>head.entity_type`,
  ],
  [
    "invalid_no_coverage_numeric_value",
    `SELECT count(*)::int AS count
     FROM measurement_bucket_revisions
     WHERE coverage_status='NO_COVERAGE'
       AND data_availability IN ('UNAVAILABLE','UNKNOWN')
       AND value_numeric IS NOT NULL`,
  ],
  [
    "invalid_fact_time_precision",
    `SELECT count(*)::int AS count
     FROM measurement_facts
     WHERE num_nonnulls(event_time,event_date)<>1
        OR (time_precision='INSTANT' AND event_time IS NULL)
        OR (time_precision='DATE' AND event_date IS NULL)`,
  ],
  [
    "failed_projection_jobs",
    `SELECT count(*)::int AS count
     FROM measurement_projection_jobs WHERE state='FAILED'`,
  ],
  [
    "failed_coverage_jobs",
    `SELECT count(*)::int AS count
     FROM coverage_reconciliation_jobs WHERE state='FAILED'`,
  ],
  [
    "active_projection_jobs",
    `SELECT count(*)::int AS count
     FROM measurement_projection_jobs WHERE state IN ('QUEUED','RUNNING')`,
  ],
  [
    "active_coverage_jobs",
    `SELECT count(*)::int AS count
     FROM coverage_reconciliation_jobs WHERE state IN ('QUEUED','RUNNING')`,
  ],
  [
    "dirty_measurement_buckets",
    `SELECT count(*)::int AS count FROM measurement_dirty_buckets`,
  ],
  [
    "dirty_coverage_buckets",
    `SELECT count(*)::int AS count FROM source_coverage_dirty_buckets`,
  ],
  [
    "active_backfill_requests",
    `SELECT count(*)::int AS count
     FROM historical_backfill_requests WHERE status IN ('QUEUED','RUNNING')`,
  ],
];

export async function runNode3FinalAudit(): Promise<Node3FinalAudit> {
  const differences: Node3AuditDifference[] = [];

  for (const [invariant, sql] of checks) {
    const result = await pool.query<{ count: number }>(sql);
    const count = result.rows[0]?.count ?? 0;
    if (count !== 0) differences.push({ invariant, count });
  }

  return {
    schemaVersion: "NODE3_FINAL_AUDIT_V1",
    accepted: differences.length === 0,
    differences,
  };
}

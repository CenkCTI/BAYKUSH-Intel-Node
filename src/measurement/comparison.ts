import { pool } from "../db/pool.js";
import type { MeasurementComparisonKind } from "./contracts.js";
import { getMeasurementRegistration } from "./registry.js";
import { enumerateBuckets, parseRfc3339Instant } from "./time.js";

export type ComparisonStatus =
  | "AVAILABLE"
  | "INSUFFICIENT_COVERAGE"
  | "INCOMPATIBLE_SOURCE_MODEL"
  | "UNSUPPORTED";

export interface PeriodComparison {
  measurementKey: string;
  current: { from: string; to: string; value: number | null };
  previous: { from: string; to: string; value: number | null };
  absoluteDelta: number | null;
  percentChange: number | null;
  comparisonStatus: ComparisonStatus;
  reason: string | null;
}

interface FactRow {
  numeric_value: string | null;
  entity_key: string | null;
  source_model_version: string | null;
  dimensions: Record<string, unknown>;
}

function parseRange(from: string, to: string): { from: Date; to: Date } {
  const start = parseRfc3339Instant(from);
  const end = parseRfc3339Instant(to);
  if (end <= start) throw new Error("Comparison range end must be after start");
  const duration = end.getTime() - start.getTime();
  if (duration > 31 * 24 * 60 * 60 * 1_000) {
    throw new Error("Comparison range is limited to 31 days in NODE-3 v1");
  }
  return { from: start, to: end };
}

async function sourceDefinitionId(sourceKey: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM source_definitions WHERE source_key=$1`,
    [sourceKey],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Source definition missing for ${sourceKey}`);
  return id;
}

async function intervalAvailable(
  sourceId: string,
  timeAxis: string,
  from: Date,
  to: Date,
): Promise<boolean> {
  const result = await pool.query<{
    window_start: Date;
    window_end: Date;
    availability_status: string;
  }>(
    `SELECT window_start,window_end,availability_status
     FROM source_acquisition_windows
     WHERE source_definition_id=$1
       AND window_kind='INTERVAL'
       AND time_axis=$2
       AND availability_status IN ('AVAILABLE','PARTIAL')
       AND window_start<$4
       AND window_end>$3
     ORDER BY window_start,window_end`,
    [sourceId, timeAxis, from, to],
  );

  let cursor = from.getTime();
  for (const row of result.rows) {
    if (row.availability_status !== "AVAILABLE") return false;
    const start = Math.max(from.getTime(), row.window_start.getTime());
    const end = Math.min(to.getTime(), row.window_end.getTime());
    if (end <= start) continue;
    if (start > cursor) return false;
    cursor = Math.max(cursor, end);
    if (cursor >= to.getTime()) return true;
  }
  return false;
}

async function datasetAvailable(
  sourceId: string,
  from: Date,
  to: Date,
): Promise<boolean> {
  const days = enumerateBuckets({
    from: from.toISOString(),
    to: to.toISOString(),
    granularity: "DAY",
    maxBuckets: 32,
  });
  if (days.length === 0) return false;

  const result = await pool.query<{ dataset_date: string }>(
    `SELECT DISTINCT dataset_date::text
     FROM source_acquisition_windows
     WHERE source_definition_id=$1
       AND window_kind='DATASET_DATE'
       AND availability_status='AVAILABLE'
       AND dataset_date >= $2::date
       AND dataset_date < $3::date`,
    [sourceId, from, to],
  );
  const available = new Set(result.rows.map((row) => row.dataset_date));
  return days.every((day) => available.has(day.start.slice(0, 10)));
}

async function liveCoverageComplete(
  sourceId: string,
  from: Date,
  to: Date,
  datePrecision: boolean,
): Promise<boolean> {
  const granularity = datePrecision ? "DAY" : "HOUR";
  const buckets = enumerateBuckets({
    from: from.toISOString(),
    to: to.toISOString(),
    granularity,
    maxBuckets: 750,
  });
  if (buckets.length === 0) return false;

  const result = await pool.query<{
    bucket_start: Date;
    coverage_status: string;
    expectation_status: string;
  }>(
    `SELECT head.bucket_start,revision.coverage_status,revision.expectation_status
     FROM source_coverage_bucket_heads head
     JOIN source_coverage_bucket_revisions revision
       ON revision.id=head.current_revision_id
     WHERE head.source_definition_id=$1
       AND head.granularity=$2
       AND head.bucket_start >= $3
       AND head.bucket_start < $4`,
    [sourceId, granularity, from, to],
  );
  const byStart = new Map(result.rows.map((row) => [row.bucket_start.toISOString(), row]));
  return buckets.every((bucket) => {
    const row = byStart.get(bucket.start);
    return row?.coverage_status === "COMPLETE" && row.expectation_status === "EXPECTED";
  });
}

async function periodComparable(
  measurementKey: string,
  from: Date,
  to: Date,
): Promise<boolean> {
  const registration = getMeasurementRegistration(measurementKey);
  if (!registration) return false;
  const sourceKey = registration.definition.sourceKeys[0];
  if (!sourceKey) return false;
  const sourceId = await sourceDefinitionId(sourceKey);

  if (registration.definition.coveragePolicy === "SOURCE_TIME_AVAILABILITY_REQUIRED") {
    return intervalAvailable(
      sourceId,
      registration.definition.primaryTimeAxis,
      from,
      to,
    );
  }

  if (registration.definition.coveragePolicy === "DATASET_AVAILABILITY_REQUIRED") {
    return datasetAvailable(sourceId, from, to);
  }

  return liveCoverageComplete(
    sourceId,
    from,
    to,
    registration.definition.timePrecision === "DATE",
  );
}

async function activeCalculationId(measurementKey: string): Promise<string> {
  const result = await pool.query<{ active_calculation_id: string }>(
    `SELECT active_calculation_id
     FROM measurement_definition_heads
     WHERE measurement_key=$1`,
    [measurementKey],
  );
  const id = result.rows[0]?.active_calculation_id;
  if (!id) throw new Error(`Measurement registry is not synchronized for ${measurementKey}`);
  return id;
}

async function factRows(
  calculationId: string,
  from: Date,
  to: Date,
  datePrecision: boolean,
): Promise<FactRow[]> {
  if (datePrecision) {
    const result = await pool.query<FactRow>(
      `SELECT fact.numeric_value::text,head.entity_key,
              fact.source_model_version,fact.dimensions
       FROM measurement_fact_heads head
       JOIN measurement_facts fact ON fact.id=head.current_fact_id
       WHERE head.measurement_calculation_id=$1
         AND head.fact_state='ACTIVE'
         AND head.event_date >= $2::date
         AND head.event_date < $3::date
       ORDER BY head.event_date,head.fact_key`,
      [calculationId, from, to],
    );
    return result.rows;
  }

  const result = await pool.query<FactRow>(
    `SELECT fact.numeric_value::text,head.entity_key,
            fact.source_model_version,fact.dimensions
     FROM measurement_fact_heads head
     JOIN measurement_facts fact ON fact.id=head.current_fact_id
     WHERE head.measurement_calculation_id=$1
       AND head.fact_state='ACTIVE'
       AND head.event_time >= $2
       AND head.event_time < $3
     ORDER BY head.event_time,head.fact_key`,
    [calculationId, from, to],
  );
  return result.rows;
}

export function aggregateComparisonRows(kind: MeasurementComparisonKind, rows: readonly FactRow[]): number | null {
  if (kind === "SUM_EVENTS") return rows.length;
  if (kind === "EXACT_DISTINCT_QUERY") {
    return new Set(
      rows.map((row) => row.entity_key).filter((value): value is string => value !== null),
    ).size;
  }
  if (kind === "LAST_VALUE") {
    const value = rows[rows.length - 1]?.numeric_value;
    if (value === null || value === undefined) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return null;
}

export async function summarizeMeasurementPeriod(input: { measurementKey: string; from: string; to: string }) {
  const registration = getMeasurementRegistration(input.measurementKey);
  if (!registration || registration.definition.visibility !== "PUBLIC") throw new Error("Unsupported measurement");
  const period = parseRange(input.from, input.to);
  const policy = registration.definition.comparisonPolicy;
  if (policy.kind === "NONE") return { measurementKey: input.measurementKey, value: null, status: "UNSUPPORTED" as const, reason: "COMPARISON_POLICY_NONE" };
  if (policy.requireCompleteCoverage && !(await periodComparable(input.measurementKey, period.from, period.to))) {
    return { measurementKey: input.measurementKey, value: null, status: "INSUFFICIENT_COVERAGE" as const, reason: "PERIOD_NOT_FULLY_COVERED" };
  }
  const rows = await factRows(await activeCalculationId(input.measurementKey), period.from, period.to, registration.definition.timePrecision === "DATE");
  const value = aggregateComparisonRows(policy.kind, rows);
  return { measurementKey: input.measurementKey, value, status: value === null ? "UNAVAILABLE" as const : "AVAILABLE" as const, reason: value === null ? "SUMMARY_VALUE_UNAVAILABLE" : null };
}

function modelContext(rows: readonly FactRow[]): {
  models: string[];
  profiles: string[];
} {
  const models = [...new Set(
    rows
      .map((row) => row.source_model_version)
      .filter((value): value is string => value !== null && value.length > 0),
  )].sort();
  const profiles = [...new Set(
    rows
      .map((row) => row.dimensions.EPSS_CAPTURE_PROFILE)
      .filter((value): value is string => typeof value === "string"),
  )].sort();
  return { models, profiles };
}

export async function comparePreviousPeriod(input: {
  measurementKey: string;
  from: string;
  to: string;
}): Promise<PeriodComparison> {
  const registration = getMeasurementRegistration(input.measurementKey);
  if (!registration || registration.definition.visibility !== "PUBLIC") {
    throw new Error("Unsupported measurement");
  }

  const policy = registration.definition.comparisonPolicy;
  const current = parseRange(input.from, input.to);
  const duration = current.to.getTime() - current.from.getTime();
  const previous = {
    from: new Date(current.from.getTime() - duration),
    to: new Date(current.to.getTime() - duration),
  };
  const currentIso = { from: current.from.toISOString(), to: current.to.toISOString() };
  const previousIso = { from: previous.from.toISOString(), to: previous.to.toISOString() };

  if (policy.kind === "NONE") {
    return {
      measurementKey: input.measurementKey,
      current: { ...currentIso, value: null },
      previous: { ...previousIso, value: null },
      absoluteDelta: null,
      percentChange: null,
      comparisonStatus: "UNSUPPORTED",
      reason: "COMPARISON_POLICY_NONE",
    };
  }

  if (policy.requireCompleteCoverage) {
    const [currentCoverage, previousCoverage] = await Promise.all([
      periodComparable(input.measurementKey, current.from, current.to),
      periodComparable(input.measurementKey, previous.from, previous.to),
    ]);
    if (!currentCoverage || !previousCoverage) {
      return {
        measurementKey: input.measurementKey,
        current: { ...currentIso, value: null },
        previous: { ...previousIso, value: null },
        absoluteDelta: null,
        percentChange: null,
        comparisonStatus: "INSUFFICIENT_COVERAGE",
        reason: "CURRENT_OR_PREVIOUS_PERIOD_NOT_FULLY_COVERED",
      };
    }
  }

  const calculationId = await activeCalculationId(input.measurementKey);
  const [currentRows, previousRows] = await Promise.all([
    factRows(
      calculationId,
      current.from,
      current.to,
      registration.definition.timePrecision === "DATE",
    ),
    factRows(
      calculationId,
      previous.from,
      previous.to,
      registration.definition.timePrecision === "DATE",
    ),
  ]);

  if (policy.requireSameSourceModelVersion || policy.requireSamePopulationProfile) {
    const currentContext = modelContext(currentRows);
    const previousContext = modelContext(previousRows);
    const modelMismatch = policy.requireSameSourceModelVersion
      && JSON.stringify(currentContext.models) !== JSON.stringify(previousContext.models);
    const profileMismatch = policy.requireSamePopulationProfile
      && JSON.stringify(currentContext.profiles) !== JSON.stringify(previousContext.profiles);
    if (modelMismatch || profileMismatch) {
      return {
        measurementKey: input.measurementKey,
        current: { ...currentIso, value: null },
        previous: { ...previousIso, value: null },
        absoluteDelta: null,
        percentChange: null,
        comparisonStatus: "INCOMPATIBLE_SOURCE_MODEL",
        reason: "SOURCE_MODEL_OR_POPULATION_PROFILE_CHANGED",
      };
    }
  }

  const currentValue = aggregateComparisonRows(policy.kind, currentRows);
  const previousValue = aggregateComparisonRows(policy.kind, previousRows);
  if (currentValue === null || previousValue === null) {
    return {
      measurementKey: input.measurementKey,
      current: { ...currentIso, value: currentValue },
      previous: { ...previousIso, value: previousValue },
      absoluteDelta: null,
      percentChange: null,
      comparisonStatus: "UNSUPPORTED",
      reason: "COMPARISON_VALUE_UNAVAILABLE",
    };
  }

  const absoluteDelta = currentValue - previousValue;
  return {
    measurementKey: input.measurementKey,
    current: { ...currentIso, value: currentValue },
    previous: { ...previousIso, value: previousValue },
    absoluteDelta,
    percentChange: previousValue === 0 ? null : (absoluteDelta / previousValue) * 100,
    comparisonStatus: "AVAILABLE",
    reason: previousValue === 0 ? "PREVIOUS_VALUE_ZERO" : null,
  };
}

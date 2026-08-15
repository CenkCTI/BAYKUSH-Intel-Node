import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { withTransaction } from "../db/pool.js";
import {
  combineRoutingMinuteDeltas,
  evaluateMinuteCoverage,
  normalizeCoverageIntervals,
  ROUTING_FINALIZATION_DELAY_MS,
  shouldMaterializeRoutingGranularity,
  type RoutingMinuteDeltaRow,
  type StreamCoverageInterval,
} from "../routing/finalize.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";
import { bucketForInstant } from "./time.js";
import { getMeasurementRegistration } from "./registry.js";
import type { MeasurementGranularity } from "./contracts.js";

const KEYS = [
  "routing.ripe_ris.update_messages",
  "routing.ripe_ris.announcement_prefix_events",
  "routing.ripe_ris.withdrawal_prefix_events",
  "routing.ripe_ris.distinct_prefixes_observed",
  "routing.ripe_ris.distinct_announced_prefixes",
  "routing.ripe_ris.distinct_withdrawn_prefixes",
  "routing.ripe_ris.distinct_origin_asns_observed",
] as const;

const ROUTING_FINALIZATION_DELAY_SECONDS = Math.ceil(ROUTING_FINALIZATION_DELAY_MS / 1000);

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number")
    : [];
}

function expectedMinutes(granularity: MeasurementGranularity): number {
  return granularity === "ONE_MINUTE" ? 1 : granularity === "FIVE_MINUTES" ? 5 : granularity === "HOUR" ? 60 : 1440;
}

async function activeCalculation(
  client: PoolClient,
  key: string,
): Promise<{ definitionId: string; calculationId: string } | null> {
  const result = await client.query<{ active_definition_id: string; active_calculation_id: string }>(
    `SELECT active_definition_id,active_calculation_id
     FROM measurement_definition_heads
     WHERE measurement_key=$1`,
    [key],
  );
  const row = result.rows[0];
  return row
    ? { definitionId: row.active_definition_id, calculationId: row.active_calculation_id }
    : null;
}

async function finalizeMinute(
  client: PoolClient,
  sourceDefinitionId: string,
  bucketStart: string,
): Promise<void> {
  const bucketEnd = new Date(Date.parse(bucketStart) + 60_000).toISOString();

  const current = await client.query<{
    id: string;
    revision_number: number;
    input_fingerprint: string;
  }>(
    `SELECT r.id,r.revision_number,r.input_fingerprint
     FROM routing_minute_bucket_heads h
     JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
     WHERE h.source_definition_id=$1 AND h.bucket_start=$2
     FOR UPDATE OF h`,
    [sourceDefinitionId, bucketStart],
  );
  const prior = current.rows[0];

  const deltaResult = await client.query<{
    segment_id: string;
    capture_profile_revision_id: string | null;
    update_message_count: string;
    announcement_prefix_event_count: string;
    withdrawal_prefix_event_count: string;
    announced_prefixes: unknown;
    withdrawn_prefixes: unknown;
    all_prefixes: unknown;
    origin_asns: unknown;
    peer_asns: unknown;
    rrcs: unknown;
    rejected_message_count: number;
    input_fingerprint: string;
  }>(
    `SELECT
       segment_id,capture_profile_revision_id,update_message_count::text,
       announcement_prefix_event_count::text,withdrawal_prefix_event_count::text,
       announced_prefixes,withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,rrcs,
       rejected_message_count,input_fingerprint
     FROM routing_segment_minute_deltas
     WHERE source_definition_id=$1 AND bucket_start=$2
     ORDER BY segment_id`,
    [sourceDefinitionId, bucketStart],
  );

  // A pre-0024 draft bucket may already exist without durable minute deltas. Preserve it rather
  // than manufacturing a replacement from incomplete historical draft state.
  if (deltaResult.rowCount === 0 && prior) return;

  const deltaRows: RoutingMinuteDeltaRow[] = deltaResult.rows.map((row) => ({
    segmentId: row.segment_id,
    captureProfileRevisionId: row.capture_profile_revision_id,
    updateMessageCount: Number(row.update_message_count),
    announcementPrefixEventCount: Number(row.announcement_prefix_event_count),
    withdrawalPrefixEventCount: Number(row.withdrawal_prefix_event_count),
    announcedPrefixes: strings(row.announced_prefixes),
    withdrawnPrefixes: strings(row.withdrawn_prefixes),
    allPrefixes: strings(row.all_prefixes),
    originAsns: numbers(row.origin_asns),
    peerAsns: numbers(row.peer_asns),
    rrcs: strings(row.rrcs),
    rejectedMessageCount: row.rejected_message_count,
    inputFingerprint: row.input_fingerprint.trim(),
  }));

  const intervalResult = await client.query<{
    id: string;
    capture_profile_revision_id: string | null;
    observed_from: Date;
    observed_to: Date;
  }>(
    `SELECT
       s.id,
       s.capture_profile_revision_id,
       MIN(m.source_time_min) AS observed_from,
       MAX(m.source_time_max) AS observed_to
     FROM stream_sessions s
     JOIN stream_segment_manifests m ON m.stream_session_id=s.id
     WHERE s.source_definition_id=$1
       AND m.source_time_min IS NOT NULL
       AND m.source_time_max IS NOT NULL
       AND m.source_time_min < $3
       AND m.source_time_max > $2
     GROUP BY s.id,s.capture_profile_revision_id
     ORDER BY observed_from,s.id`,
    [sourceDefinitionId, bucketStart, bucketEnd],
  );

  const intervals: StreamCoverageInterval[] = intervalResult.rows.map((row) => ({
    sessionId: row.id,
    captureProfileRevisionId: row.capture_profile_revision_id,
    observedFrom: row.observed_from.toISOString(),
    observedTo: row.observed_to.toISOString(),
  }));
  const normalizedIntervals = normalizeCoverageIntervals(bucketStart, bucketEnd, intervals);

  const snapshot = combineRoutingMinuteDeltas(deltaRows);
  const coverage = evaluateMinuteCoverage({
    bucketStart,
    bucketEnd,
    intervals,
    deltaProfileIds: snapshot.deltaProfileIds,
    rejectedMessages: snapshot.rejectedMessages,
    hasObservedData: deltaRows.length > 0,
  });

  const inputFingerprint = hash({
    deltas: deltaRows.map((row) => ({
      segmentId: row.segmentId,
      inputFingerprint: row.inputFingerprint,
      captureProfileRevisionId: row.captureProfileRevisionId,
    })),
    intervals: normalizedIntervals,
    coverageStatus: coverage.coverageStatus,
    captureProfileRevisionId: coverage.captureProfileRevisionId,
  });

  if (prior?.input_fingerprint.trim() === inputFingerprint) return;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO routing_minute_bucket_revisions(
       source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,
       update_message_count,announcement_prefix_event_count,withdrawal_prefix_event_count,
       announced_prefixes,withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,rrcs,
       coverage_status,data_availability,acquisition_basis,input_segment_count,
       input_fingerprint,revision_number,supersedes_revision_id
     )
     VALUES(
       $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,
       $14,$15,'LIVE_STREAM',$16,$17,$18,$19
     )
     RETURNING id`,
    [
      sourceDefinitionId,
      coverage.captureProfileRevisionId,
      bucketStart,
      bucketEnd,
      snapshot.updateMessages,
      snapshot.announcementPrefixEvents,
      snapshot.withdrawalPrefixEvents,
      canonicalJsonStringify(snapshot.announcedPrefixes),
      canonicalJsonStringify(snapshot.withdrawnPrefixes),
      canonicalJsonStringify(snapshot.allPrefixes),
      canonicalJsonStringify(snapshot.originAsns),
      canonicalJsonStringify(snapshot.peerAsns),
      canonicalJsonStringify(snapshot.rrcs),
      coverage.coverageStatus,
      coverage.dataAvailability,
      snapshot.inputSegmentCount,
      inputFingerprint,
      (prior?.revision_number ?? 0) + 1,
      prior?.id ?? null,
    ],
  );

  const revisionId = inserted.rows[0]?.id;
  if (!revisionId) throw new Error("Failed to finalize routing minute revision");

  await client.query(
    `INSERT INTO routing_minute_bucket_heads(
       source_definition_id,bucket_start,bucket_end,current_revision_id
     )
     VALUES($1,$2,$3,$4)
     ON CONFLICT(source_definition_id,bucket_start) DO UPDATE SET
       bucket_end=EXCLUDED.bucket_end,
       current_revision_id=EXCLUDED.current_revision_id,
       updated_at=now()`,
    [sourceDefinitionId, bucketStart, bucketEnd, revisionId],
  );
}

async function materialize(
  client: PoolClient,
  input: {
    sourceDefinitionId: string;
    granularity: MeasurementGranularity;
    bucketStart: string;
    bucketEnd: string;
  },
): Promise<void> {
  const rows = await client.query<{
    id: string;
    capture_profile_revision_id: string | null;
    update_message_count: string;
    announcement_prefix_event_count: string;
    withdrawal_prefix_event_count: string;
    announced_prefixes: unknown;
    withdrawn_prefixes: unknown;
    all_prefixes: unknown;
    origin_asns: unknown;
    coverage_status: string;
    data_availability: string;
  }>(
    `SELECT
       r.id,r.capture_profile_revision_id,r.update_message_count::text,
       r.announcement_prefix_event_count::text,r.withdrawal_prefix_event_count::text,
       r.announced_prefixes,r.withdrawn_prefixes,r.all_prefixes,r.origin_asns,
       r.coverage_status,r.data_availability
     FROM routing_minute_bucket_heads h
     JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
     WHERE h.source_definition_id=$1 AND h.bucket_start>=$2 AND h.bucket_start<$3
     ORDER BY h.bucket_start`,
    [input.sourceDefinitionId, input.bucketStart, input.bucketEnd],
  );

  const expected = expectedMinutes(input.granularity);
  const profiles = [
    ...new Set(
      rows.rows
        .map((row) => row.capture_profile_revision_id)
        .filter((value): value is string => Boolean(value)),
    ),
  ].sort();
  const compatibleProfile = profiles.length === 1
    && rows.rows.every((row) => row.capture_profile_revision_id === profiles[0]);
  const complete = rows.rows.length === expected
    && rows.rows.every((row) => row.coverage_status === "COMPLETE" && row.data_availability === "AVAILABLE")
    && compatibleProfile;
  const degraded = rows.rows.some((row) => row.coverage_status === "DEGRADED");
  const coverage = complete
    ? "COMPLETE"
    : rows.rows.length === 0
      ? "NO_COVERAGE"
      : degraded
        ? "DEGRADED"
        : "PARTIAL";
  const availability = complete
    ? "AVAILABLE"
    : rows.rows.length === 0
      ? "UNAVAILABLE"
      : "PARTIAL";

  const updateMessages = rows.rows.reduce((sum, row) => sum + Number(row.update_message_count), 0);
  const announcements = rows.rows.reduce((sum, row) => sum + Number(row.announcement_prefix_event_count), 0);
  const withdrawals = rows.rows.reduce((sum, row) => sum + Number(row.withdrawal_prefix_event_count), 0);
  const allPrefixes = [...new Set(rows.rows.flatMap((row) => strings(row.all_prefixes)))].sort();
  const announcedPrefixes = [...new Set(rows.rows.flatMap((row) => strings(row.announced_prefixes)))].sort();
  const withdrawnPrefixes = [...new Set(rows.rows.flatMap((row) => strings(row.withdrawn_prefixes)))].sort();
  const originAsns = [...new Set(rows.rows.flatMap((row) => numbers(row.origin_asns)))].sort((a, b) => a - b);

  const values: Record<(typeof KEYS)[number], number> = {
    "routing.ripe_ris.update_messages": updateMessages,
    "routing.ripe_ris.announcement_prefix_events": announcements,
    "routing.ripe_ris.withdrawal_prefix_events": withdrawals,
    "routing.ripe_ris.distinct_prefixes_observed": allPrefixes.length,
    "routing.ripe_ris.distinct_announced_prefixes": announcedPrefixes.length,
    "routing.ripe_ris.distinct_withdrawn_prefixes": withdrawnPrefixes.length,
    "routing.ripe_ris.distinct_origin_asns_observed": originAsns.length,
  };

  const inputFingerprint = hash({ revisionIds: rows.rows.map((row) => row.id), profiles });

  for (const key of KEYS) {
    if (!getMeasurementRegistration(key)) continue;
    const ids = await activeCalculation(client, key);
    if (!ids) continue;

    const current = await client.query<{
      id: string;
      revision_number: number;
      input_fingerprint: string;
    }>(
      `SELECT r.id,r.revision_number,r.input_fingerprint
       FROM measurement_bucket_heads h
       JOIN measurement_bucket_revisions r ON r.id=h.current_revision_id
       WHERE h.measurement_calculation_id=$1
         AND h.granularity=$2
         AND h.bucket_start=$3
         AND h.scope_key='GLOBAL'
       FOR UPDATE OF h`,
      [ids.calculationId, input.granularity, input.bucketStart],
    );
    const prior = current.rows[0];
    if (prior?.input_fingerprint.trim() === inputFingerprint) continue;

    const numeric = complete ? values[key] : null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO measurement_bucket_revisions(
         measurement_definition_id,measurement_calculation_id,granularity,bucket_start,bucket_end,
         scope_key,time_axis,value_numeric,coverage_status,expectation_status,data_availability,
         acquisition_summary,bucket_state,comparison_context,input_fact_count,input_fingerprint,
         coverage_input_fingerprint,revision_number,supersedes_revision_id,revision_reason
       )
       VALUES(
         $1,$2,$3,$4,$5,'GLOBAL','SOURCE_OBSERVED_TIME',$6,$7,'EXPECTED',$8,$9::jsonb,$10,
         $11::jsonb,$12,$13,$13,$14,$15,$16
       )
       RETURNING id`,
      [
        ids.definitionId,
        ids.calculationId,
        input.granularity,
        input.bucketStart,
        input.bucketEnd,
        numeric,
        coverage,
        availability,
        canonicalJsonStringify([{ basis: "RIPE_RIS_STREAM", minuteRows: rows.rows.length }]),
        prior ? "REVISED" : "SETTLED",
        canonicalJsonStringify({
          captureProfileRevisionIds: profiles,
          populationCompatible: compatibleProfile,
        }),
        rows.rows.length,
        inputFingerprint,
        (prior?.revision_number ?? 0) + 1,
        prior?.id ?? null,
        prior ? "ROUTING_INPUT_REVISED" : "ROUTING_BUCKET_MATERIALIZED",
      ],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new Error(`Failed routing measurement ${key}`);

    await client.query(
      `INSERT INTO measurement_bucket_heads(
         measurement_calculation_id,granularity,bucket_start,bucket_end,scope_key,current_revision_id
       )
       VALUES($1,$2,$3,$4,'GLOBAL',$5)
       ON CONFLICT(measurement_calculation_id,granularity,bucket_start,scope_key) DO UPDATE SET
         bucket_end=EXCLUDED.bucket_end,
         current_revision_id=EXCLUDED.current_revision_id,
         updated_at=now()`,
      [ids.calculationId, input.granularity, input.bucketStart, input.bucketEnd, id],
    );
  }

  const coverageCurrent = await client.query<{
    id: string;
    revision_number: number;
    input_fingerprint: string;
  }>(
    `SELECT r.id,r.revision_number,r.input_fingerprint
     FROM source_coverage_bucket_heads h
     JOIN source_coverage_bucket_revisions r ON r.id=h.current_revision_id
     WHERE h.source_definition_id=$1 AND h.granularity=$2 AND h.bucket_start=$3
     FOR UPDATE OF h`,
    [input.sourceDefinitionId, input.granularity, input.bucketStart],
  );
  const cp = coverageCurrent.rows[0];

  if (cp?.input_fingerprint.trim() !== inputFingerprint) {
    const satisfied = complete ? expected : 0;
    const partial = coverage === "PARTIAL" ? Math.min(expected, rows.rows.length) : 0;
    const failed = coverage === "DEGRADED" ? Math.min(1, expected) : 0;
    const missing = Math.max(0, expected - satisfied - partial - failed);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO source_coverage_bucket_revisions(
         source_definition_id,granularity,bucket_start,bucket_end,expectation_status,coverage_status,
         evaluation_state,expected_opportunity_count,satisfied_opportunity_count,partial_opportunity_count,
         failed_opportunity_count,missing_opportunity_count,schedule_origin,reason_codes,input_fingerprint,
         revision_number,supersedes_revision_id
       )
       VALUES(
         $1,$2,$3,$4,'EXPECTED',$5,$6,$7,$8,$9,$10,$11,'AUTHORITATIVE_NODE3',$12::jsonb,$13,$14,$15
       )
       RETURNING id`,
      [
        input.sourceDefinitionId,
        input.granularity,
        input.bucketStart,
        input.bucketEnd,
        coverage,
        cp ? "REVISED" : "FINAL",
        expected,
        satisfied,
        partial,
        failed,
        missing,
        canonicalJsonStringify([
          compatibleProfile ? "STREAM_TELEMETRY_COVERAGE" : "STREAM_POPULATION_INCOMPATIBLE",
        ]),
        inputFingerprint,
        (cp?.revision_number ?? 0) + 1,
        cp?.id ?? null,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id) {
      await client.query(
        `INSERT INTO source_coverage_bucket_heads(
           source_definition_id,granularity,bucket_start,bucket_end,current_revision_id
         )
         VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(source_definition_id,granularity,bucket_start) DO UPDATE SET
           bucket_end=EXCLUDED.bucket_end,
           current_revision_id=EXCLUDED.current_revision_id,
           updated_at=now()`,
        [input.sourceDefinitionId, input.granularity, input.bucketStart, input.bucketEnd, id],
      );
    }
  }
}

export async function routingMeasurementTick(): Promise<boolean> {
  return withTransaction(async (client) => {
    const dirty = await client.query<{
      source_definition_id: string;
      bucket_start: Date;
    }>(
      `SELECT source_definition_id,bucket_start
       FROM routing_measurement_dirty_minutes
       WHERE bucket_start + interval '1 minute' <= now() - ($1::int * interval '1 second')
       ORDER BY dirty_since,bucket_start
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [ROUTING_FINALIZATION_DELAY_SECONDS],
    );
    const row = dirty.rows[0];
    if (!row) return false;

    const minuteStart = row.bucket_start.toISOString();
    await finalizeMinute(client, row.source_definition_id, minuteStart);

    const now = new Date();
    for (const granularity of ["ONE_MINUTE", "FIVE_MINUTES", "HOUR", "DAY"] as const) {
      const bucket = bucketForInstant(row.bucket_start, granularity);
      if (!shouldMaterializeRoutingGranularity(granularity, bucket.end, now)) continue;
      await materialize(client, {
        sourceDefinitionId: row.source_definition_id,
        granularity,
        bucketStart: bucket.start,
        bucketEnd: bucket.end,
      });
    }

    await client.query(
      `DELETE FROM routing_measurement_dirty_minutes
       WHERE source_definition_id=$1 AND bucket_start=$2`,
      [row.source_definition_id, row.bucket_start],
    );
    return true;
  });
}

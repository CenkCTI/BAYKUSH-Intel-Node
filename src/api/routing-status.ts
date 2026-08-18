import type { ServerResponse } from "node:http";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { sendEnvelope, sendError } from "./http.js";
import { classifyHeartbeat, routingAcquisitionChannel } from "./routing-status-contract.js";

interface HeartbeatRow {
  component: "STREAM_WORKER" | "RECOVERY_WORKER";
  heartbeat_at: Date;
}

interface StreamSessionRow {
  status: string;
  started_at: Date;
  connected_at: Date | null;
  ended_at: Date | null;
  last_source_observed_at: Date | null;
  last_node_received_at: Date | null;
  message_count: string;
  segment_count: string;
}

interface RecoveryRequestRow {
  status: string;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface RoutingBucketRow {
  bucket_start: Date;
  bucket_end: Date;
  update_messages: string;
  announcement_prefix_events: string;
  withdrawal_prefix_events: string;
  distinct_prefixes_observed: number;
  distinct_origin_asns_observed: number;
  rrc_count: number;
  coverage_status: string;
  data_availability: string;
  acquisition_basis: string;
  live_collection_coverage: string;
  capture_profile_key: string | null;
  capture_profile_version: string | null;
  capture_profile_rrc_count: number | null;
}

const ROUTING_BUCKET_SELECT = `SELECT
  r.bucket_start,r.bucket_end,
  r.update_message_count::text AS update_messages,
  r.announcement_prefix_event_count::text AS announcement_prefix_events,
  r.withdrawal_prefix_event_count::text AS withdrawal_prefix_events,
  jsonb_array_length(r.all_prefixes) AS distinct_prefixes_observed,
  jsonb_array_length(r.origin_asns) AS distinct_origin_asns_observed,
  jsonb_array_length(r.rrcs) AS rrc_count,
  r.coverage_status,r.data_availability,r.acquisition_basis,
  COALESCE(r.live_collection_coverage_status,
    CASE WHEN r.acquisition_basis='LIVE_STREAM' THEN r.coverage_status ELSE 'NO_COVERAGE' END
  ) AS live_collection_coverage,
  p.profile_key AS capture_profile_key,
  p.profile_version AS capture_profile_version,
  CASE WHEN p.rrc_set IS NULL THEN NULL ELSE jsonb_array_length(p.rrc_set) END AS capture_profile_rrc_count
FROM routing_minute_bucket_heads h
JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
LEFT JOIN stream_capture_profile_revisions p ON p.id=r.capture_profile_revision_id`;

function publicBucket(row: RoutingBucketRow | null) {
  return row ? {
    bucketStart: row.bucket_start.toISOString(),
    bucketEnd: row.bucket_end.toISOString(),
    updateMessages: row.update_messages,
    announcementPrefixEvents: row.announcement_prefix_events,
    withdrawalPrefixEvents: row.withdrawal_prefix_events,
    distinctPrefixesObserved: row.distinct_prefixes_observed,
    distinctOriginAsnsObserved: row.distinct_origin_asns_observed,
    rrcCount: row.rrc_count,
    coverageStatus: row.coverage_status,
    dataAvailability: row.data_availability,
    acquisitionBasis: row.acquisition_basis,
    acquisitionChannel: routingAcquisitionChannel(row.acquisition_basis),
    liveCollectionCoverage: row.live_collection_coverage,
    captureProfileKey: row.capture_profile_key,
    captureProfileVersion: row.capture_profile_version,
    captureProfileRrcCount: row.capture_profile_rrc_count,
  } : null;
}

export async function routingStatus(response: ServerResponse, id: string): Promise<void> {
  const source = await pool.query<{
    id: string;
    source_key: string;
    display_name: string;
    represents: string;
    does_not_represent: string;
  }>(
    `SELECT id,source_key,display_name,represents,does_not_represent
     FROM source_definitions WHERE source_key='RIPE_RIS_BGP' LIMIT 1`,
  );
  const definition = source.rows[0];
  if (!definition) return sendError(response, 404, "NOT_FOUND", "RIPE RIS routing source is not registered", id);

  const [heartbeatResult, sessionResult, recoveryResult, latestResult, latestRecoveredResult] = await Promise.all([
    pool.query<HeartbeatRow>(
      `SELECT component,MAX(heartbeat_at) AS heartbeat_at
       FROM runtime_heartbeats
       WHERE component IN ('STREAM_WORKER','RECOVERY_WORKER')
       GROUP BY component`,
    ),
    pool.query<StreamSessionRow>(
      `SELECT status,started_at,connected_at,ended_at,last_source_observed_at,last_node_received_at,
              message_count::text,segment_count::text
       FROM stream_sessions
       WHERE source_definition_id=$1
       ORDER BY started_at DESC LIMIT 1`,
      [definition.id],
    ),
    pool.query<RecoveryRequestRow>(
      `SELECT status,created_at,started_at,completed_at
       FROM stream_recovery_requests
       WHERE source_definition_id=$1
       ORDER BY created_at DESC LIMIT 1`,
      [definition.id],
    ),
    pool.query<RoutingBucketRow>(
      `${ROUTING_BUCKET_SELECT}
       WHERE h.source_definition_id=$1
       ORDER BY h.bucket_start DESC LIMIT 1`,
      [definition.id],
    ),
    pool.query<RoutingBucketRow>(
      `${ROUTING_BUCKET_SELECT}
       WHERE h.source_definition_id=$1 AND r.acquisition_basis='MRT_RECOVERY'
       ORDER BY h.bucket_start DESC LIMIT 1`,
      [definition.id],
    ),
  ]);

  const heartbeatByComponent = new Map(heartbeatResult.rows.map((row) => [row.component, row.heartbeat_at]));
  const streamHeartbeat = heartbeatByComponent.get("STREAM_WORKER") ?? null;
  const recoveryHeartbeat = heartbeatByComponent.get("RECOVERY_WORKER") ?? null;
  const session = sessionResult.rows[0] ?? null;
  const recovery = recoveryResult.rows[0] ?? null;
  const latest = latestResult.rows[0] ?? null;
  const latestRecovered = latestRecoveredResult.rows[0] ?? null;
  const staleAfterMs = config.heartbeatIntervalMs * 3;
  const nowMs = Date.now();

  sendEnvelope(response, 200, {
    sourceKey: definition.source_key,
    displayName: definition.display_name,
    authority: "BAYKUSH_INTELLIGENCE_NODE",
    upstreamOrigin: "RIPE_RIS",
    attribution: "RIPE NCC Routing Information Service (RIS)",
    represents: definition.represents,
    doesNotRepresent: definition.does_not_represent,
    stream: {
      heartbeatAt: streamHeartbeat?.toISOString() ?? null,
      heartbeatFreshness: classifyHeartbeat(streamHeartbeat?.toISOString() ?? null, nowMs, staleAfterMs),
      latestSessionStatus: session?.status ?? null,
      latestSessionStartedAt: session?.started_at.toISOString() ?? null,
      latestSessionConnectedAt: session?.connected_at?.toISOString() ?? null,
      latestSessionEndedAt: session?.ended_at?.toISOString() ?? null,
      latestSourceObservedAt: session?.last_source_observed_at?.toISOString() ?? null,
      latestNodeReceivedAt: session?.last_node_received_at?.toISOString() ?? null,
      messagesObserved: session?.message_count ?? null,
      segmentsPersisted: session?.segment_count ?? null,
    },
    recovery: {
      heartbeatAt: recoveryHeartbeat?.toISOString() ?? null,
      heartbeatFreshness: classifyHeartbeat(recoveryHeartbeat?.toISOString() ?? null, nowMs, staleAfterMs),
      latestRequestStatus: recovery?.status ?? null,
      latestRequestCreatedAt: recovery?.created_at.toISOString() ?? null,
      latestRequestStartedAt: recovery?.started_at?.toISOString() ?? null,
      latestRequestCompletedAt: recovery?.completed_at?.toISOString() ?? null,
    },
    latest: publicBucket(latest),
    latestRecovered: publicBucket(latestRecovered),
  }, id, {
    heartbeatStaleAfterMs: staleAfterMs,
    note: "Operational worker freshness, live collection coverage, current data availability, and acquisition basis are independent. latestRecovered is the newest current minute head whose acquisition basis remains MRT_RECOVERY; it never rewrites the historical live collection state.",
  });
}

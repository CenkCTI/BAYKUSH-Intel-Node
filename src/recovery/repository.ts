import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import type { RoutingMinuteDelta } from "../stream/contracts.js";
import type { DownloadedMrtArtifact } from "./fetcher.js";
import type { DecoderRunResult } from "./decoder.js";
import { recoveryCompleteness } from "./projection.js";
import {
  DECODER_CONTRACT_VERSION,
  DECODER_NAME,
  DECODER_UPSTREAM_COMMIT,
  DECODER_UPSTREAM_TAG,
  DECODER_VERSION,
  isRetryableRecoveryFailure,
  recoveryBackoffSeconds,
  stableSha256,
  type RecoveryFailureCode,
} from "./policy.js";

export interface ClaimedRecoverySegment {
  segmentId: string;
  requestId: string;
  sourceDefinitionId: string;
  captureProfileRevisionId: string;
  rrc: string;
  windowStart: string;
  windowEnd: string;
  sourceUrl: string;
  requestedFrom: string;
  requestedTo: string;
  attemptCount: number;
}

interface ClaimedRow {
  segmentId: string;
  requestId: string;
  sourceDefinitionId: string;
  captureProfileRevisionId: string;
  rrc: string;
  windowStart: Date;
  windowEnd: Date;
  sourceUrl: string;
  requestedFrom: Date;
  requestedTo: Date;
  attemptCount: number;
}

interface RecoveryAggregate {
  updates: number;
  announcements: number;
  withdrawals: number;
  announced: string[];
  withdrawn: string[];
  all: string[];
  origins: number[];
  peers: number[];
  ipv4: number;
  ipv6: number;
  rejected: number;
}

function jsonArray<T extends string | number>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((entry): entry is T => typeof entry === "string" || typeof entry === "number") : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid numeric recovery value");
  return parsed;
}

function sorted<T extends string | number>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => String(a).localeCompare(String(b), "en", { numeric: true }));
}

async function attemptEvent(
  client: PoolClient,
  segmentId: string,
  attemptNumber: number,
  eventType: string,
  details: Record<string, unknown> = {},
  failureCode?: string,
): Promise<void> {
  await client.query(
    `INSERT INTO stream_recovery_attempt_events(
       recovery_segment_id,attempt_number,event_type,failure_code,details
     ) VALUES($1,$2,$3,$4,$5::jsonb)`,
    [segmentId, attemptNumber, eventType, failureCode ?? null, JSON.stringify(details)],
  );
}

export async function queueRecoveryRequest(requestId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE stream_recovery_requests
     SET status='QUEUED',completed_at=NULL,updated_at=now()
     WHERE id=$1 AND status IN ('PLANNED','PARTIAL','FAILED')`,
    [requestId],
  );
  if (result.rowCount === 0) throw new Error("Recovery request cannot be queued from its current state");
}

export async function cancelRecoveryRequest(requestId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE stream_recovery_requests
       SET status='CANCELLED',completed_at=now(),updated_at=now()
       WHERE id=$1 AND status NOT IN ('SUCCEEDED','CANCELLED')`,
      [requestId],
    );
    const cancelled = await client.query<{ id: string; attempt_count: number }>(
      `UPDATE stream_recovery_segments
       SET state='CANCELLED',claimed_by=NULL,lease_until=NULL,next_retry_at=NULL
       WHERE recovery_request_id=$1 AND state<>'PROJECTED'
       RETURNING id,attempt_count`,
      [requestId],
    );
    for (const row of cancelled.rows) {
      if (row.attempt_count > 0) await attemptEvent(client, row.id, row.attempt_count, "CANCELLED");
    }
  });
}

export async function retryRecoverySegment(segmentId: string): Promise<void> {
  await withTransaction(async (client) => {
    const row = await client.query<{ request_id: string; attempt_count: number }>(
      `UPDATE stream_recovery_segments s
       SET next_retry_at=now(),failure_code=NULL,failure_message=NULL,last_failure_code=NULL
       FROM stream_recovery_requests r
       WHERE s.id=$1 AND r.id=s.recovery_request_id
         AND s.state='FAILED' AND s.attempt_count<$2
         AND r.status IN ('RUNNING','PARTIAL','FAILED','QUEUED')
       RETURNING r.id AS request_id,s.attempt_count`,
      [segmentId, config.recoveryMaxAttempts],
    );
    const claimed = row.rows[0];
    if (!claimed) throw new Error("Recovery segment is not retryable");
    await client.query(
      `UPDATE stream_recovery_requests SET status='QUEUED',completed_at=NULL,updated_at=now() WHERE id=$1`,
      [claimed.request_id],
    );
    await attemptEvent(client, segmentId, Math.max(1, claimed.attempt_count), "RETRY_SCHEDULED", { operatorRequested: true });
  });
}

export async function claimRecoverySegment(instanceId: string): Promise<ClaimedRecoverySegment | null> {
  return withTransaction(async (client) => {
    const result = await client.query<ClaimedRow>(
      `WITH candidate AS (
         SELECT s.id
         FROM stream_recovery_segments s
         JOIN stream_recovery_requests r ON r.id=s.recovery_request_id
         WHERE r.status IN ('QUEUED','RUNNING')
           AND r.target_capture_profile_revision_id IS NOT NULL
           AND s.attempt_count<$2
           AND (
             s.state='PLANNED'
             OR (s.state='FAILED' AND s.next_retry_at IS NOT NULL AND s.next_retry_at<=now())
             OR (s.state IN ('FETCHING','DOWNLOADED','VERIFYING','DECODING','DECODED','PROJECTING') AND s.lease_until<now())
           )
         ORDER BY r.priority ASC,s.window_start ASC,s.segment_index ASC
         FOR UPDATE OF s SKIP LOCKED LIMIT 1
       ), claimed AS (
         UPDATE stream_recovery_segments s
         SET state='FETCHING',attempt_count=s.attempt_count+1,claimed_by=$1,
             lease_until=now()+($3::text||' seconds')::interval,
             next_retry_at=NULL,last_failure_code=NULL
         FROM candidate c WHERE s.id=c.id
         RETURNING s.*
       )
       SELECT c.id AS "segmentId",c.recovery_request_id AS "requestId",
              c.source_definition_id AS "sourceDefinitionId",
              r.target_capture_profile_revision_id AS "captureProfileRevisionId",
              c.rrc,c.window_start AS "windowStart",c.window_end AS "windowEnd",
              c.source_url AS "sourceUrl",r.requested_from AS "requestedFrom",
              r.requested_to AS "requestedTo",c.attempt_count AS "attemptCount"
       FROM claimed c JOIN stream_recovery_requests r ON r.id=c.recovery_request_id`,
      [instanceId, config.recoveryMaxAttempts, config.recoveryLeaseSeconds],
    );
    const row = result.rows[0];
    if (!row) return null;
    await client.query(
      `UPDATE stream_recovery_requests
       SET status='RUNNING',started_at=COALESCE(started_at,now()),updated_at=now()
       WHERE id=$1`,
      [row.requestId],
    );
    await attemptEvent(client, row.segmentId, row.attemptCount, "CLAIMED", { instanceId });
    await attemptEvent(client, row.segmentId, row.attemptCount, "FETCH_STARTED");
    return {
      segmentId: row.segmentId,
      requestId: row.requestId,
      sourceDefinitionId: row.sourceDefinitionId,
      captureProfileRevisionId: row.captureProfileRevisionId,
      rrc: row.rrc,
      windowStart: row.windowStart.toISOString(),
      windowEnd: row.windowEnd.toISOString(),
      sourceUrl: row.sourceUrl,
      requestedFrom: row.requestedFrom.toISOString(),
      requestedTo: row.requestedTo.toISOString(),
      attemptCount: row.attemptCount,
    };
  });
}

export async function recordDownloadedArtifact(
  segment: ClaimedRecoverySegment,
  artifact: DownloadedMrtArtifact,
): Promise<{ artifactId: string; changed: boolean }> {
  return withTransaction(async (client) => {
    const prior = await client.query<{ sha256: string }>(
      `SELECT sha256 FROM stream_recovery_artifacts
       WHERE source_url=$1 ORDER BY downloaded_at DESC LIMIT 1`,
      [artifact.sourceUrl],
    );
    const priorSha = prior.rows[0]?.sha256.trim();
    const changed = priorSha !== undefined && priorSha !== artifact.sha256;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO stream_recovery_artifacts(
         recovery_segment_id,source_definition_id,rrc,window_start,window_end,source_url,
         sha256,compressed_bytes,http_status,etag,last_modified,staging_key,downloaded_at,expires_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT(recovery_segment_id,sha256) DO UPDATE
         SET staging_status='READY',expires_at=EXCLUDED.expires_at
       RETURNING id`,
      [
        segment.segmentId, segment.sourceDefinitionId, segment.rrc, segment.windowStart, segment.windowEnd,
        artifact.sourceUrl, artifact.sha256, artifact.compressedBytes, artifact.httpStatus,
        artifact.etag, artifact.lastModified, artifact.stagingKey, artifact.downloadedAt, artifact.expiresAt,
      ],
    );
    const artifactId = inserted.rows[0]?.id;
    if (!artifactId) throw new Error("Failed to persist recovery artifact");
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='DOWNLOADED',artifact_id=$2,artifact_sha256=$3,artifact_bytes=$4,downloaded_at=$5,
           lease_until=now()+($6::text||' seconds')::interval
       WHERE id=$1`,
      [segment.segmentId, artifactId, artifact.sha256, artifact.compressedBytes, artifact.downloadedAt, config.recoveryLeaseSeconds],
    );
    await attemptEvent(client, segment.segmentId, segment.attemptCount, "DOWNLOADED", {
      artifactId, sha256: artifact.sha256, bytes: artifact.compressedBytes,
    });
    if (changed) {
      await attemptEvent(client, segment.segmentId, segment.attemptCount, "ARTIFACT_CHANGED", {
        previousSha256: priorSha, currentSha256: artifact.sha256,
      });
    }
    return { artifactId, changed };
  });
}

export async function markArtifactVerified(segment: ClaimedRecoverySegment, artifactId: string): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='VERIFYING',lease_until=now()+($3::text||' seconds')::interval
       WHERE id=$1 AND artifact_id=$2`,
      [segment.segmentId, artifactId, config.recoveryLeaseSeconds],
    );
    await attemptEvent(client, segment.segmentId, segment.attemptCount, "VERIFY_STARTED", { artifactId });
  });
}

export async function startDecoderRun(
  segment: ClaimedRecoverySegment,
  artifactId: string,
  artifactSha256: string,
  binarySha256: string,
): Promise<string> {
  return withTransaction(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO stream_recovery_decoder_runs(
         recovery_segment_id,artifact_id,decoder_name,decoder_version,decoder_upstream_tag,
         decoder_upstream_commit,decoder_binary_sha256,decoder_contract_version,arguments,
         artifact_sha256,status
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,'RUNNING') RETURNING id`,
      [
        segment.segmentId, artifactId, DECODER_NAME, DECODER_VERSION, DECODER_UPSTREAM_TAG,
        DECODER_UPSTREAM_COMMIT, binarySha256, DECODER_CONTRACT_VERSION,
        JSON.stringify(["<local-staged-artifact>"]), artifactSha256,
      ],
    );
    const id = row.rows[0]?.id;
    if (!id) throw new Error("Failed to start decoder provenance run");
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='DECODING',decoder_run_id=$2,lease_until=now()+($3::text||' seconds')::interval
       WHERE id=$1`,
      [segment.segmentId, id, config.recoveryLeaseSeconds],
    );
    await attemptEvent(client, segment.segmentId, segment.attemptCount, "DECODE_STARTED", { decoderRunId: id });
    return id;
  });
}

export async function finishDecoderRun(
  segment: ClaimedRecoverySegment,
  decoderRunId: string,
  result: DecoderRunResult,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE stream_recovery_decoder_runs
       SET status='SUCCEEDED',records_read=$2,updates_decoded=$3,records_ignored=$4,
           records_rejected=$5,output_sha256=$6,exit_code=$7,completed_at=now()
       WHERE id=$1 AND status='RUNNING'`,
      [
        decoderRunId, result.recordsRead, result.updatesDecoded, result.recordsIgnored,
        result.recordsRejected, result.outputSha256, result.exitCode,
      ],
    );
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='DECODED',lease_until=now()+($2::text||' seconds')::interval WHERE id=$1`,
      [segment.segmentId, config.recoveryLeaseSeconds],
    );
    await attemptEvent(client, segment.segmentId, segment.attemptCount, "DECODED", {
      records: result.recordsRead, outputSha256: result.outputSha256,
    });
  });
}

export async function failDecoderRun(
  decoderRunId: string,
  code: RecoveryFailureCode,
  message: string,
): Promise<void> {
  await pool.query(
    `UPDATE stream_recovery_decoder_runs
     SET status='FAILED',failure_code=$2,failure_message=$3,
         exit_code=COALESCE(exit_code,-1),completed_at=now()
     WHERE id=$1 AND status='RUNNING'`,
    [decoderRunId, code, message.slice(0, 4000)],
  );
}

function aggregate(rows: Array<Record<string, unknown>>): RecoveryAggregate {
  let updates = 0;
  let announcements = 0;
  let withdrawals = 0;
  let ipv4 = 0;
  let ipv6 = 0;
  let rejected = 0;
  const announced = new Set<string>();
  const withdrawn = new Set<string>();
  const all = new Set<string>();
  const origins = new Set<number>();
  const peers = new Set<number>();
  for (const row of rows) {
    updates += numberValue(row.update_message_count);
    announcements += numberValue(row.announcement_prefix_event_count);
    withdrawals += numberValue(row.withdrawal_prefix_event_count);
    ipv4 += numberValue(row.ipv4_prefix_events);
    ipv6 += numberValue(row.ipv6_prefix_events);
    rejected += numberValue(row.rejected_record_count);
    for (const value of jsonArray<string>(row.announced_prefixes)) announced.add(value);
    for (const value of jsonArray<string>(row.withdrawn_prefixes)) withdrawn.add(value);
    for (const value of jsonArray<string>(row.all_prefixes)) all.add(value);
    for (const value of jsonArray<number>(row.origin_asns)) origins.add(Number(value));
    for (const value of jsonArray<number>(row.peer_asns)) peers.add(Number(value));
  }
  return {
    updates, announcements, withdrawals,
    announced: sorted(announced), withdrawn: sorted(withdrawn), all: sorted(all),
    origins: sorted(origins), peers: sorted(peers), ipv4, ipv6, rejected,
  };
}

async function promoteCompleteRecovery(
  client: PoolClient,
  input: {
    sourceDefinitionId: string;
    profileId: string;
    bucketStart: string;
    projectionFingerprint: string;
    aggregate: RecoveryAggregate;
    expectedRrcs: string[];
  },
): Promise<boolean> {
  const current = await client.query<{
    id: string;
    revision_number: number;
    acquisition_basis: string;
    coverage_status: string;
    input_fingerprint: string;
  }>(
    `SELECT r.id,r.revision_number,r.acquisition_basis,r.coverage_status,r.input_fingerprint
     FROM routing_minute_bucket_heads h
     JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
     WHERE h.source_definition_id=$1 AND h.bucket_start=$2
     FOR UPDATE OF h`,
    [input.sourceDefinitionId, input.bucketStart],
  );
  const head = current.rows[0];
  if (head?.acquisition_basis === "LIVE_STREAM" && head.coverage_status === "COMPLETE") return false;
  if (head?.acquisition_basis === "MRT_RECOVERY" && head.input_fingerprint.trim() === input.projectionFingerprint) return false;

  const live = await client.query<{ coverage_status: string }>(
    `SELECT coverage_status FROM routing_minute_bucket_revisions
     WHERE source_definition_id=$1 AND bucket_start=$2 AND acquisition_basis='LIVE_STREAM'
     ORDER BY revision_number DESC LIMIT 1`,
    [input.sourceDefinitionId, input.bucketStart],
  );
  const liveCoverage = live.rows[0]?.coverage_status ?? "NO_COVERAGE";
  const revisionNumber = (head?.revision_number ?? 0) + 1;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO routing_minute_bucket_revisions(
       source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,
       update_message_count,announcement_prefix_event_count,withdrawal_prefix_event_count,
       announced_prefixes,withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,rrcs,
       coverage_status,data_availability,acquisition_basis,input_segment_count,input_fingerprint,
       revision_number,supersedes_revision_id,live_collection_coverage_status
     ) VALUES(
       $1,$2,$3,$3::timestamptz+interval '1 minute',$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,
       $10::jsonb,$11::jsonb,$12::jsonb,'COMPLETE','AVAILABLE','MRT_RECOVERY',$13,$14,$15,$16,$17
     ) RETURNING id`,
    [
      input.sourceDefinitionId, input.profileId, input.bucketStart,
      input.aggregate.updates, input.aggregate.announcements, input.aggregate.withdrawals,
      JSON.stringify(input.aggregate.announced), JSON.stringify(input.aggregate.withdrawn),
      JSON.stringify(input.aggregate.all), JSON.stringify(input.aggregate.origins),
      JSON.stringify(input.aggregate.peers), JSON.stringify(input.expectedRrcs), input.expectedRrcs.length,
      input.projectionFingerprint, revisionNumber, head?.id ?? null, liveCoverage,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("Failed to promote MRT recovery revision");
  await client.query(
    `INSERT INTO routing_minute_bucket_heads(source_definition_id,bucket_start,bucket_end,current_revision_id)
     VALUES($1,$2,$2::timestamptz+interval '1 minute',$3)
     ON CONFLICT(source_definition_id,bucket_start) DO UPDATE SET
       current_revision_id=EXCLUDED.current_revision_id,updated_at=now()`,
    [input.sourceDefinitionId, input.bucketStart, id],
  );
  await client.query(
    `INSERT INTO routing_measurement_dirty_minutes(source_definition_id,bucket_start)
     VALUES($1,$2)
     ON CONFLICT(source_definition_id,bucket_start) DO UPDATE SET
       dirty_since=LEAST(routing_measurement_dirty_minutes.dirty_since,EXCLUDED.dirty_since),
       dirty_revision=routing_measurement_dirty_minutes.dirty_revision+1`,
    [input.sourceDefinitionId, input.bucketStart],
  );
  return true;
}

async function recomputeRecoveryMinutes(client: PoolClient, requestId: string): Promise<void> {
  const request = await client.query<{
    source_definition_id: string;
    target_capture_profile_revision_id: string;
    requested_from: Date;
    requested_to: Date;
    rrc_set: unknown;
  }>(
    `SELECT source_definition_id,target_capture_profile_revision_id,requested_from,requested_to,rrc_set
     FROM stream_recovery_requests WHERE id=$1`,
    [requestId],
  );
  const req = request.rows[0];
  if (!req) return;
  const expected = sorted(jsonArray<string>(req.rrc_set));
  let cursor = Math.floor(req.requested_from.getTime() / 60_000) * 60_000;
  const end = req.requested_to.getTime();
  while (cursor < end) {
    const bucketStart = new Date(cursor).toISOString();
    const rows = await client.query<Record<string, unknown>>(
      `SELECT d.*,a.sha256 AS artifact_sha256,dr.output_sha256
       FROM routing_recovery_minute_deltas d
       JOIN stream_recovery_segments s ON s.id=d.recovery_segment_id
       JOIN stream_recovery_artifacts a ON a.id=d.artifact_id
       JOIN stream_recovery_decoder_runs dr ON dr.id=d.decoder_run_id
       WHERE s.recovery_request_id=$1 AND d.bucket_start=$2
         AND s.state='PROJECTED'
         AND s.artifact_id=d.artifact_id
         AND s.decoder_run_id=d.decoder_run_id
       ORDER BY d.rrc`,
      [requestId, bucketStart],
    );
    const projected = sorted(rows.rows.map((row) => String(row.rrc)));
    const aggregateValue = aggregate(rows.rows);
    const completeness = recoveryCompleteness(expected, projected, aggregateValue.rejected);
    const artifactFingerprint = stableSha256(rows.rows.map((row) => [row.rrc, row.artifact_sha256]));
    const decoderFingerprint = stableSha256(rows.rows.map((row) => [row.rrc, row.output_sha256]));
    const projectionFingerprint = stableSha256({
      requestId,
      bucketStart,
      profile: req.target_capture_profile_revision_id,
      expected,
      projected,
      status: completeness.status,
      aggregate: aggregateValue,
      inputs: rows.rows.map((row) => row.input_fingerprint),
    });
    const previous = await client.query<{
      id: string;
      revision_number: number;
      projection_fingerprint: string;
    }>(
      `SELECT r.id,r.revision_number,r.projection_fingerprint
       FROM routing_recovery_minute_heads h
       JOIN routing_recovery_minute_revisions r ON r.id=h.current_revision_id
       WHERE h.source_definition_id=$1 AND h.bucket_start=$2
         AND h.target_capture_profile_revision_id=$3
       FOR UPDATE OF h`,
      [req.source_definition_id, bucketStart, req.target_capture_profile_revision_id],
    );
    const prior = previous.rows[0];
    if (prior?.projection_fingerprint.trim() !== projectionFingerprint) {
      const revisionNumber = (prior?.revision_number ?? 0) + 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO routing_recovery_minute_revisions(
           source_definition_id,bucket_start,bucket_end,target_capture_profile_revision_id,
           expected_rrc_count,projected_rrc_count,expected_rrcs,projected_rrcs,missing_rrcs,
           status,data_availability,recovery_request_ids,update_message_count,
           announcement_prefix_event_count,withdrawal_prefix_event_count,announced_prefixes,
           withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,ipv4_prefix_events,
           ipv6_prefix_events,artifact_fingerprint,decoder_fingerprint,projection_fingerprint,
           revision_number,supersedes_revision_id
         ) VALUES(
           $1,$2,$2::timestamptz+interval '1 minute',$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,
           $9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18::jsonb,$19::jsonb,
           $20,$21,$22,$23,$24,$25,$26
         ) RETURNING id`,
        [
          req.source_definition_id, bucketStart, req.target_capture_profile_revision_id,
          expected.length, projected.length, JSON.stringify(expected), JSON.stringify(projected),
          JSON.stringify(completeness.missingRrcs), completeness.status, completeness.availability,
          JSON.stringify([requestId]), aggregateValue.updates, aggregateValue.announcements,
          aggregateValue.withdrawals, JSON.stringify(aggregateValue.announced),
          JSON.stringify(aggregateValue.withdrawn), JSON.stringify(aggregateValue.all),
          JSON.stringify(aggregateValue.origins), JSON.stringify(aggregateValue.peers),
          aggregateValue.ipv4, aggregateValue.ipv6, artifactFingerprint, decoderFingerprint,
          projectionFingerprint, revisionNumber, prior?.id ?? null,
        ],
      );
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new Error("Failed to persist recovery minute revision");
      await client.query(
        `INSERT INTO routing_recovery_minute_heads(
           source_definition_id,bucket_start,target_capture_profile_revision_id,current_revision_id
         ) VALUES($1,$2,$3,$4)
         ON CONFLICT(source_definition_id,bucket_start,target_capture_profile_revision_id) DO UPDATE SET
           current_revision_id=EXCLUDED.current_revision_id,updated_at=now()`,
        [req.source_definition_id, bucketStart, req.target_capture_profile_revision_id, revisionId],
      );
      if (completeness.status === "COMPLETE" && completeness.availability === "AVAILABLE") {
        await promoteCompleteRecovery(client, {
          sourceDefinitionId: req.source_definition_id,
          profileId: req.target_capture_profile_revision_id,
          bucketStart,
          projectionFingerprint,
          aggregate: aggregateValue,
          expectedRrcs: expected,
        });
      }
    }
    cursor += 60_000;
  }
}

async function refreshRequestStatus(client: PoolClient, requestId: string): Promise<void> {
  const counts = await client.query<{
    total: string;
    projected: string;
    terminal_failed: string;
    retryable_failed: string;
  }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER(WHERE state='PROJECTED')::text AS projected,
            count(*) FILTER(WHERE state='FAILED' AND (next_retry_at IS NULL OR attempt_count>=$2))::text AS terminal_failed,
            count(*) FILTER(WHERE state='FAILED' AND next_retry_at IS NOT NULL AND attempt_count<$2)::text AS retryable_failed
     FROM stream_recovery_segments WHERE recovery_request_id=$1`,
    [requestId, config.recoveryMaxAttempts],
  );
  const row = counts.rows[0];
  if (!row) return;
  const total = Number(row.total);
  const projected = Number(row.projected);
  const terminal = Number(row.terminal_failed);
  const retryable = Number(row.retryable_failed);
  if (projected === total && total > 0) {
    await client.query(
      `UPDATE stream_recovery_requests
       SET status='SUCCEEDED',segments_completed=$2,completed_at=now(),updated_at=now(),
           failure_code=NULL,failure_message=NULL WHERE id=$1`,
      [requestId, projected],
    );
    return;
  }
  if (projected + terminal === total && retryable === 0 && total > 0) {
    await client.query(
      `UPDATE stream_recovery_requests
       SET status=$2,segments_completed=$3,completed_at=now(),updated_at=now() WHERE id=$1`,
      [requestId, projected > 0 ? "PARTIAL" : "FAILED", projected],
    );
    return;
  }
  await client.query(
    `UPDATE stream_recovery_requests SET status='RUNNING',segments_completed=$2,updated_at=now() WHERE id=$1`,
    [requestId, projected],
  );
}

export async function persistRecoveryProjection(input: {
  segment: ClaimedRecoverySegment;
  artifactId: string;
  decoderRunId: string;
  decoder: DecoderRunResult;
  deltas: Array<{ delta: RoutingMinuteDelta; fingerprint: string }>;
}): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='PROJECTING',lease_until=now()+($2::text||' seconds')::interval WHERE id=$1`,
      [input.segment.segmentId, config.recoveryLeaseSeconds],
    );
    await attemptEvent(client, input.segment.segmentId, input.segment.attemptCount, "PROJECT_STARTED", {
      minutes: input.deltas.length,
    });
    for (const item of input.deltas) {
      const existing = await client.query<{ input_fingerprint: string }>(
        `SELECT input_fingerprint FROM routing_recovery_minute_deltas
         WHERE recovery_segment_id=$1 AND artifact_id=$2 AND bucket_start=$3`,
        [input.segment.segmentId, input.artifactId, item.delta.bucketStart],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (prior.input_fingerprint.trim() !== item.fingerprint) throw new Error("PROJECTION_CONFLICT");
        continue;
      }
      await client.query(
        `INSERT INTO routing_recovery_minute_deltas(
           recovery_segment_id,artifact_id,decoder_run_id,source_definition_id,
           target_capture_profile_revision_id,rrc,bucket_start,bucket_end,update_message_count,
           announcement_prefix_event_count,withdrawal_prefix_event_count,announced_prefixes,
           withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,ipv4_prefix_events,
           ipv6_prefix_events,decoded_record_count,ignored_record_count,rejected_record_count,input_fingerprint
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,
           $16::jsonb,$17,$18,$19,$20,$21,$22
         )`,
        [
          input.segment.segmentId, input.artifactId, input.decoderRunId,
          input.segment.sourceDefinitionId, input.segment.captureProfileRevisionId, input.segment.rrc,
          item.delta.bucketStart, item.delta.bucketEnd, item.delta.updateMessages,
          item.delta.announcementPrefixEvents, item.delta.withdrawalPrefixEvents,
          JSON.stringify(item.delta.announcedPrefixes), JSON.stringify(item.delta.withdrawnPrefixes),
          JSON.stringify(item.delta.allPrefixes), JSON.stringify(item.delta.originAsns),
          JSON.stringify(item.delta.peerAsns), item.delta.ipv4PrefixEvents, item.delta.ipv6PrefixEvents,
          input.decoder.recordsRead, input.decoder.recordsIgnored, input.decoder.recordsRejected,
          item.fingerprint,
        ],
      );
    }
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='PROJECTED',projected_at=now(),claimed_by=NULL,lease_until=NULL,
           next_retry_at=NULL,last_failure_code=NULL WHERE id=$1`,
      [input.segment.segmentId],
    );
    await attemptEvent(client, input.segment.segmentId, input.segment.attemptCount, "PROJECTED", {
      minutes: input.deltas.length,
    });
    await recomputeRecoveryMinutes(client, input.segment.requestId);
    await refreshRequestStatus(client, input.segment.requestId);
  });
}

export async function markRecoverySegmentFailure(
  segment: ClaimedRecoverySegment,
  code: RecoveryFailureCode,
  message: string,
): Promise<void> {
  await withTransaction(async (client) => {
    const retry = isRetryableRecoveryFailure(code) && segment.attemptCount < config.recoveryMaxAttempts;
    const delay = retry
      ? recoveryBackoffSeconds(segment.attemptCount, config.recoveryRetryBaseSeconds, config.recoveryRetryMaxSeconds)
      : null;
    await client.query(
      `UPDATE stream_recovery_segments
       SET state='FAILED',failure_code=$2,failure_message=$3,last_failure_code=$2,
           claimed_by=NULL,lease_until=NULL,
           next_retry_at=CASE WHEN $4::integer IS NULL THEN NULL ELSE now()+($4::text||' seconds')::interval END
       WHERE id=$1`,
      [segment.segmentId, code, message.slice(0, 4000), delay],
    );
    await attemptEvent(
      client,
      segment.segmentId,
      segment.attemptCount,
      retry ? "RETRY_SCHEDULED" : "FAILED",
      retry ? { delaySeconds: delay } : {},
      code,
    );
    await client.query(
      `UPDATE stream_recovery_requests
       SET failure_code=$2,failure_message=$3,updated_at=now() WHERE id=$1`,
      [segment.requestId, code, message.slice(0, 4000)],
    );
    await refreshRequestStatus(client, segment.requestId);
  });
}

export async function streamHealthyForRecovery(): Promise<boolean> {
  if (!config.recoveryPauseOnStreamUnhealthy) return true;
  const source = await pool.query<{ enabled: boolean }>(
    `SELECT enabled FROM source_definitions WHERE source_key='RIPE_RIS_BGP'`,
  );
  if (!source.rows[0]?.enabled) return true;
  const heartbeat = await pool.query<{ healthy: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM runtime_heartbeats
       WHERE component='STREAM_WORKER' AND heartbeat_at>now()-interval '30 seconds'
     ) AS healthy`,
  );
  return heartbeat.rows[0]?.healthy ?? false;
}

export async function recoveryStatus(requestId?: string): Promise<unknown> {
  if (requestId) {
    const request = await pool.query(
      `SELECT id,source_definition_id,requested_from,requested_to,rrc_set,reason,status,
              segments_planned,segments_completed,target_capture_profile_revision_id,policy_revision,
              plan_fingerprint,priority,automatic,trigger_reason,trigger_event_id,created_by,
              failure_code,failure_message,created_at,started_at,completed_at,updated_at
       FROM stream_recovery_requests WHERE id=$1`,
      [requestId],
    );
    const segments = await pool.query(
      `SELECT id,segment_index,rrc,window_start,window_end,state,attempt_count,last_failure_code,
              next_retry_at,artifact_sha256,artifact_bytes,downloaded_at,projected_at
       FROM stream_recovery_segments WHERE recovery_request_id=$1 ORDER BY segment_index`,
      [requestId],
    );
    return { request: request.rows[0] ?? null, segments: segments.rows };
  }
  const summary = await pool.query(
    `SELECT status,count(*)::integer AS count FROM stream_recovery_requests GROUP BY status ORDER BY status`,
  );
  return { requests: summary.rows };
}

async function auditCount(sql: string, requestId?: string): Promise<number> {
  const result = await pool.query<{ count: string }>(sql, [requestId ?? null]);
  return Number(result.rows[0]?.count ?? 0);
}

export async function auditRecovery(requestId?: string): Promise<Record<string, number>> {
  return {
    orphanArtifacts: await auditCount(
      `SELECT count(*)::text AS count FROM stream_recovery_artifacts a
       LEFT JOIN stream_recovery_segments s ON s.id=a.recovery_segment_id
       WHERE s.id IS NULL AND ($1::uuid IS NULL OR a.recovery_segment_id IN (
         SELECT id FROM stream_recovery_segments WHERE recovery_request_id=$1
       ))`, requestId,
    ),
    orphanDecoderRuns: await auditCount(
      `SELECT count(*)::text AS count FROM stream_recovery_decoder_runs d
       LEFT JOIN stream_recovery_segments s ON s.id=d.recovery_segment_id
       WHERE s.id IS NULL AND ($1::uuid IS NULL OR d.recovery_segment_id IN (
         SELECT id FROM stream_recovery_segments WHERE recovery_request_id=$1
       ))`, requestId,
    ),
    orphanRecoveryDeltas: await auditCount(
      `SELECT count(*)::text AS count FROM routing_recovery_minute_deltas d
       LEFT JOIN stream_recovery_segments s ON s.id=d.recovery_segment_id
       LEFT JOIN stream_recovery_artifacts a ON a.id=d.artifact_id
       LEFT JOIN stream_recovery_decoder_runs r ON r.id=d.decoder_run_id
       WHERE (s.id IS NULL OR a.id IS NULL OR r.id IS NULL)
         AND ($1::uuid IS NULL OR d.recovery_segment_id IN (
           SELECT id FROM stream_recovery_segments WHERE recovery_request_id=$1
         ))`, requestId,
    ),
    projectedWithoutDecoderSuccess: await auditCount(
      `SELECT count(*)::text AS count FROM stream_recovery_segments s
       LEFT JOIN stream_recovery_decoder_runs d ON d.id=s.decoder_run_id
       WHERE s.state='PROJECTED' AND COALESCE(d.status,'')<>'SUCCEEDED'
         AND ($1::uuid IS NULL OR s.recovery_request_id=$1)`, requestId,
    ),
    successfulWithMissingRrc: await auditCount(
      `SELECT count(*)::text AS count FROM stream_recovery_requests r
       WHERE r.status='SUCCEEDED' AND r.target_capture_profile_revision_id IS NOT NULL
         AND ($1::uuid IS NULL OR r.id=$1)
         AND EXISTS (
           SELECT 1
           FROM generate_series(
             date_trunc('minute',r.requested_from),
             date_trunc('minute',r.requested_to-interval '1 microsecond'),
             interval '1 minute'
           ) AS minute(bucket_start)
           LEFT JOIN routing_recovery_minute_heads h
             ON h.source_definition_id=r.source_definition_id
            AND h.bucket_start=minute.bucket_start
            AND h.target_capture_profile_revision_id=r.target_capture_profile_revision_id
           LEFT JOIN routing_recovery_minute_revisions x ON x.id=h.current_revision_id
           WHERE h.current_revision_id IS NULL OR x.status<>'COMPLETE'
              OR x.projected_rrc_count<>x.expected_rrc_count
         )`, requestId,
    ),
    mrtPromotionWithoutCompleteRecovery: await auditCount(
      `SELECT count(*)::text AS count FROM routing_minute_bucket_revisions m
       WHERE m.acquisition_basis='MRT_RECOVERY'
         AND ($1::uuid IS NULL OR EXISTS(
           SELECT 1 FROM stream_recovery_requests q
           WHERE q.id=$1 AND q.source_definition_id=m.source_definition_id
             AND m.bucket_start>=q.requested_from AND m.bucket_start<q.requested_to
         ))
         AND NOT EXISTS (
           SELECT 1 FROM routing_recovery_minute_heads h
           JOIN routing_recovery_minute_revisions x ON x.id=h.current_revision_id
           WHERE h.source_definition_id=m.source_definition_id
             AND h.bucket_start=m.bucket_start
             AND h.target_capture_profile_revision_id=m.capture_profile_revision_id
             AND x.status='COMPLETE' AND x.data_availability='AVAILABLE'
         )`, requestId,
    ),
    recoveryProfileMismatch: await auditCount(
      `SELECT count(*)::text AS count FROM routing_recovery_minute_deltas d
       JOIN stream_recovery_segments s ON s.id=d.recovery_segment_id
       JOIN stream_recovery_requests r ON r.id=s.recovery_request_id
       WHERE d.target_capture_profile_revision_id<>r.target_capture_profile_revision_id
         AND ($1::uuid IS NULL OR r.id=$1)`, requestId,
    ),
    duplicateProjectionFingerprint: await auditCount(
      `SELECT count(*)::text AS count FROM (
         SELECT projection_fingerprint FROM routing_recovery_minute_revisions x
         WHERE $1::uuid IS NULL OR EXISTS(
           SELECT 1 FROM jsonb_array_elements_text(x.recovery_request_ids) item
           WHERE item::uuid=$1
         )
         GROUP BY projection_fingerprint HAVING count(*)>1
       ) duplicate`, requestId,
    ),
  };
}

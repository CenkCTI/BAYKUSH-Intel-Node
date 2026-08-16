import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pool, withTransaction } from "../db/pool.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";
import { aggregateRoutingObservations, fingerprintRoutingDelta } from "../routing/aggregate.js";
import { parseRisPayload } from "./ripe-ris/schema.js";
import { ripeRisSubscription } from "./ripe-ris/source.js";
import type { QueuedStreamMessage, RoutingObservation } from "./contracts.js";

const SOURCE_KEY = "RIPE_RIS_BGP";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function unionStrings(...groups: readonly string[][]): string[] {
  return [...new Set(groups.flat())].sort();
}

function unionNumbers(...groups: readonly number[][]): number[] {
  return [...new Set(groups.flat())].sort((a, b) => a - b);
}

function minIso(current: string | null, next: string): string {
  return current === null || Date.parse(next) < Date.parse(current) ? next : current;
}

function maxIso(current: string | null, next: string): string {
  return current === null || Date.parse(next) > Date.parse(current) ? next : current;
}

export async function loadRipeSourceState(): Promise<{ id: string; enabled: boolean } | null> {
  const result = await pool.query<{ id: string; enabled: boolean }>(
    "SELECT id,enabled FROM source_definitions WHERE source_key=$1",
    [SOURCE_KEY],
  );
  return result.rows[0] ?? null;
}

export async function createStreamSession(sourceDefinitionId: string, instanceId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO stream_sessions(source_definition_id,runtime_instance_id,status)
     VALUES($1,$2,'CONNECTING') RETURNING id`,
    [sourceDefinitionId, instanceId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error("Failed to create stream session");
  return id;
}

export async function updateStreamSession(
  sessionId: string,
  status: "CONNECTING" | "CONNECTED" | "STREAMING" | "DRAINING" | "CLOSED" | "FAILED",
  reason: string | null = null,
): Promise<void> {
  await pool.query(
    `UPDATE stream_sessions
     SET status=$2,
         connected_at=CASE WHEN $2='CONNECTED' AND connected_at IS NULL THEN now() ELSE connected_at END,
         subscribed_at=CASE WHEN $2='STREAMING' AND subscribed_at IS NULL THEN now() ELSE subscribed_at END,
         ended_at=CASE WHEN $2 IN ('CLOSED','FAILED') THEN now() ELSE ended_at END,
         end_reason=COALESCE($3,end_reason),
         updated_at=now()
     WHERE id=$1`,
    [sessionId, status, reason],
  );
  if (status === "FAILED") {
    await pool.query(
      `INSERT INTO routing_measurement_dirty_minutes(source_definition_id,bucket_start)
       SELECT DISTINCT session.source_definition_id,delta.bucket_start
       FROM stream_sessions session
       JOIN stream_segment_manifests manifest ON manifest.stream_session_id=session.id
       JOIN routing_segment_minute_deltas delta ON delta.segment_id=manifest.id
       WHERE session.id=$1
       ON CONFLICT(source_definition_id,bucket_start) DO UPDATE SET
         dirty_revision=routing_measurement_dirty_minutes.dirty_revision+1,
         dirty_since=LEAST(routing_measurement_dirty_minutes.dirty_since,now())`,
      [sessionId],
    );
  }
}

export async function recordStreamEvent(
  sessionId: string,
  eventType: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO stream_session_events(stream_session_id,event_type,details)
     VALUES($1,$2,$3::jsonb)`,
    [sessionId, eventType, canonicalJsonStringify(details)],
  );
}

export async function ensureCaptureProfile(sourceDefinitionId: string, rrcs: readonly string[]): Promise<string> {
  const canonical = [...new Set(rrcs)].sort();
  if (canonical.length === 0) throw new Error("RIPE RIS capture profile requires a non-empty RRC population");

  const rrcHash = sha256(canonicalJsonStringify(canonical));
  const subscription = {
    ...ripeRisSubscription,
    socketOptions: { ...ripeRisSubscription.socketOptions },
  };
  const subscriptionHash = sha256(canonicalJsonStringify(subscription));
  const contractHash = sha256(canonicalJsonStringify({ sourceKey: SOURCE_KEY, rrcs: canonical, subscription }));
  const version = `rrc-${rrcHash.slice(0, 16)}`;

  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO stream_capture_profile_revisions(
       source_definition_id,profile_key,profile_version,effective_from,rrc_set,subscription,
       rrc_set_sha256,subscription_sha256,contract_sha256
     )
     VALUES($1,'RIPE_RIS_ACTIVE_RRCS',$2,now(),$3::jsonb,$4::jsonb,$5,$6,$7)
     ON CONFLICT(source_definition_id,profile_key,profile_version) DO NOTHING
     RETURNING id`,
    [
      sourceDefinitionId,
      version,
      canonicalJsonStringify(canonical),
      canonicalJsonStringify(subscription),
      rrcHash,
      subscriptionHash,
      contractHash,
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) return insertedId;

  const existing = await pool.query<{ id: string }>(
    `SELECT id
     FROM stream_capture_profile_revisions
     WHERE source_definition_id=$1
       AND profile_key='RIPE_RIS_ACTIVE_RRCS'
       AND profile_version=$2`,
    [sourceDefinitionId, version],
  );
  const id = existing.rows[0]?.id;
  if (!id) throw new Error("Failed to ensure capture profile");
  return id;
}

export async function attachCaptureProfile(sessionId: string, profileId: string): Promise<void> {
  await pool.query(
    `UPDATE stream_sessions
     SET capture_profile_revision_id=$2,updated_at=now()
     WHERE id=$1`,
    [sessionId, profileId],
  );
}

export async function persistStreamSegment(input: {
  sourceDefinitionId: string;
  sessionId: string;
  profileId: string | null;
  sequence: number;
  messages: readonly QueuedStreamMessage[];
  rawRetentionHours: number;
}): Promise<{
  inserted: boolean;
  rejected: number;
  minutes: number;
  compressedBytes: number;
  uncompressedBytes: number;
  compressionMs: number;
  projectionMs: number;
  databaseMs: number;
  totalMs: number;
}> {
  const totalStartedAt = Date.now();
  if (!input.messages.length) return {
    inserted: false, rejected: 0, minutes: 0, compressedBytes: 0, uncompressedBytes: 0,
    compressionMs: 0, projectionMs: 0, databaseMs: 0, totalMs: 0,
  };

  const payload = input.messages.map((message) => message.raw).join("\n");
  const uncompressedBytes = Buffer.byteLength(payload);
  const compressionStartedAt = Date.now();
  const compressed = gzipSync(Buffer.from(payload, "utf8"));
  const compressionMs = Date.now() - compressionStartedAt;
  const projectionStartedAt = Date.now();
  const observations: RoutingObservation[] = [];
  let rejected = 0;
  let updateMessages = 0;
  let firstId: string | null = null;
  let lastId: string | null = null;
  let sourceMin: string | null = null;
  let sourceMax: string | null = null;

  for (const message of input.messages) {
    try {
      const parsed = parseRisPayload(message.raw, message.receivedAt);
      if (parsed && "sourceObservedAt" in parsed) {
        observations.push(parsed);
        updateMessages += 1;
        firstId ??= parsed.messageId;
        lastId = parsed.messageId ?? lastId;
        sourceMin = minIso(sourceMin, parsed.sourceObservedAt);
        sourceMax = maxIso(sourceMax, parsed.sourceObservedAt);
      }
    } catch {
      rejected += 1;
    }
  }

  const deltas = aggregateRoutingObservations(observations, rejected);
  const contentHash = sha256(payload);
  const nodeMin = input.messages[0]!.receivedAt;
  const nodeMax = input.messages[input.messages.length - 1]!.receivedAt;
  const projectionMs = Date.now() - projectionStartedAt;
  const databaseStartedAt = Date.now();

  const persisted = await withTransaction(async (client) => {
    const manifest = await client.query<{ id: string }>(
      `INSERT INTO stream_segment_manifests(
         source_definition_id,capture_profile_revision_id,stream_session_id,segment_sequence,
         source_time_min,source_time_max,node_received_min,node_received_max,message_count,
         update_message_count,peer_state_message_count,rejected_message_count,uncompressed_bytes,
         compressed_bytes,content_sha256,first_message_id,last_message_id,acquisition_channel
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13,$14,$15,$16,'RIS_LIVE_WEBSOCKET')
       ON CONFLICT(source_definition_id,acquisition_channel,content_sha256) DO NOTHING
       RETURNING id`,
      [
        input.sourceDefinitionId,
        input.profileId,
        input.sessionId,
        input.sequence,
        sourceMin,
        sourceMax,
        nodeMin,
        nodeMax,
        input.messages.length,
        updateMessages,
        rejected,
        uncompressedBytes,
        compressed.byteLength,
        contentHash,
        firstId,
        lastId,
      ],
    );
    const segmentId = manifest.rows[0]?.id;
    if (!segmentId) return { inserted: false, rejected, minutes: 0 };

    await client.query(
      `INSERT INTO stream_segment_payloads(segment_id,payload_compressed,compression,expires_at)
       VALUES($1,$2,'GZIP',now()+($3::text||' hours')::interval)`,
      [segmentId, compressed, input.rawRetentionHours],
    );

    const aggregate = {
      updateMessages: deltas.reduce((sum, delta) => sum + delta.updateMessages, 0),
      announcements: deltas.reduce((sum, delta) => sum + delta.announcementPrefixEvents, 0),
      withdrawals: deltas.reduce((sum, delta) => sum + delta.withdrawalPrefixEvents, 0),
      announced: unionStrings(...deltas.map((delta) => [...delta.announcedPrefixes])),
      withdrawn: unionStrings(...deltas.map((delta) => [...delta.withdrawnPrefixes])),
      all: unionStrings(...deltas.map((delta) => [...delta.allPrefixes])),
      origins: unionNumbers(...deltas.map((delta) => [...delta.originAsns])),
      peers: unionNumbers(...deltas.map((delta) => [...delta.peerAsns])),
      rrcs: unionStrings(...deltas.map((delta) => [...delta.rrcs])),
      ipv4: deltas.reduce((sum, delta) => sum + delta.ipv4PrefixEvents, 0),
      ipv6: deltas.reduce((sum, delta) => sum + delta.ipv6PrefixEvents, 0),
    };

    await client.query(
      `INSERT INTO routing_segment_deltas(
         segment_id,calculation_version,update_message_count,announcement_prefix_event_count,
         withdrawal_prefix_event_count,announced_prefixes,withdrawn_prefixes,all_prefixes,
         origin_asns,peer_asns,rrcs,ipv4_prefix_event_count,ipv6_prefix_event_count,
         rejected_message_count,input_fingerprint
       )
       VALUES($1,'v1',$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14)`,
      [
        segmentId,
        aggregate.updateMessages,
        aggregate.announcements,
        aggregate.withdrawals,
        canonicalJsonStringify(aggregate.announced),
        canonicalJsonStringify(aggregate.withdrawn),
        canonicalJsonStringify(aggregate.all),
        canonicalJsonStringify(aggregate.origins),
        canonicalJsonStringify(aggregate.peers),
        canonicalJsonStringify(aggregate.rrcs),
        aggregate.ipv4,
        aggregate.ipv6,
        rejected,
        sha256(canonicalJsonStringify({ segmentId, aggregate })),
      ],
    );

    for (const delta of deltas) {
      const deltaFingerprint = fingerprintRoutingDelta(delta);
      await client.query(
        `INSERT INTO routing_segment_minute_deltas(
           segment_id,source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,
           update_message_count,announcement_prefix_event_count,withdrawal_prefix_event_count,
           announced_prefixes,withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,rrcs,
           ipv4_prefix_event_count,ipv6_prefix_event_count,rejected_message_count,input_fingerprint
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18)
         ON CONFLICT(segment_id,bucket_start) DO NOTHING`,
        [
          segmentId,
          input.sourceDefinitionId,
          input.profileId,
          delta.bucketStart,
          delta.bucketEnd,
          delta.updateMessages,
          delta.announcementPrefixEvents,
          delta.withdrawalPrefixEvents,
          canonicalJsonStringify(delta.announcedPrefixes),
          canonicalJsonStringify(delta.withdrawnPrefixes),
          canonicalJsonStringify(delta.allPrefixes),
          canonicalJsonStringify(delta.originAsns),
          canonicalJsonStringify(delta.peerAsns),
          canonicalJsonStringify(delta.rrcs),
          delta.ipv4PrefixEvents,
          delta.ipv6PrefixEvents,
          delta.rejectedMessages,
          deltaFingerprint,
        ],
      );
      await client.query(
        `INSERT INTO routing_measurement_dirty_minutes(source_definition_id,bucket_start)
         VALUES($1,$2)
         ON CONFLICT(source_definition_id,bucket_start) DO UPDATE SET
           dirty_revision=routing_measurement_dirty_minutes.dirty_revision+1,
           dirty_since=LEAST(routing_measurement_dirty_minutes.dirty_since,now())`,
        [input.sourceDefinitionId, delta.bucketStart],
      );
    }

    await client.query(
      `UPDATE stream_sessions
       SET message_count=message_count+$2,
           segment_count=segment_count+1,
           received_bytes=received_bytes+$3,
           last_source_observed_at=COALESCE($4,last_source_observed_at),
           last_node_received_at=$5,
           updated_at=now()
       WHERE id=$1`,
      [input.sessionId, input.messages.length, Buffer.byteLength(payload), sourceMax, nodeMax],
    );

    return { inserted: true, rejected, minutes: deltas.length };
  });
  return {
    ...persisted,
    compressedBytes: compressed.byteLength,
    uncompressedBytes,
    compressionMs,
    projectionMs,
    databaseMs: Date.now() - databaseStartedAt,
    totalMs: Date.now() - totalStartedAt,
  };
}

export async function ensureCoveredMinute(input: {
  sourceDefinitionId: string;
  profileId: string | null;
  instant: Date;
}): Promise<void> {
  if (!input.profileId) return;
  const endMs = Math.floor(input.instant.getTime() / 60000) * 60000;
  const start = new Date(endMs - 60000).toISOString();

  await withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT 1
       FROM routing_minute_bucket_heads
       WHERE source_definition_id=$1 AND bucket_start=$2`,
      [input.sourceDefinitionId, start],
    );
    if (existing.rowCount) return;

    await client.query(
      `INSERT INTO routing_measurement_dirty_minutes(source_definition_id,bucket_start)
       VALUES($1,$2)
       ON CONFLICT(source_definition_id,bucket_start) DO NOTHING`,
      [input.sourceDefinitionId, start],
    );
  });
}

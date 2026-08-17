import { pool } from "../src/db/pool.js";

interface Check { check: string; accepted: boolean; detail?: string }

function workflowError(error: unknown): void {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const escaped = raw.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.error(`::error title=NODE-6.2 PostgreSQL acceptance::${escaped}`);
}

async function run(): Promise<void> {
  if (process.env.NODE6_2_ACCEPTANCE_CONFIRMED !== "true") {
    throw new Error("Set NODE6_2_ACCEPTANCE_CONFIRMED=true to run PostgreSQL-backed NODE-6.2 acceptance");
  }

  const checks: Check[] = [];
  const schema = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM information_schema.tables
     WHERE table_schema=current_schema() AND table_name IN (
       'stream_recovery_policy_revisions','stream_recovery_artifacts','stream_recovery_decoder_runs',
       'stream_recovery_attempt_events','routing_recovery_minute_deltas',
       'routing_recovery_minute_revisions','routing_recovery_minute_heads'
     )`,
  );
  checks.push({ check: "node6-2-schema-present", accepted: schema.rows[0]?.count === 7, detail: `tables=${schema.rows[0]?.count ?? 0}/7` });

  const policy = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM stream_recovery_policy_revisions
     WHERE policy_revision='NODE6_2_RECOVERY_POLICY_V1' AND automatic_gap_max_seconds=1800
       AND manual_request_max_seconds=21600 AND hard_max_segments=10000
       AND download_concurrency=2 AND decoder_concurrency=1 AND projection_concurrency=1`,
  );
  checks.push({ check: "versioned-recovery-policy", accepted: policy.rows[0]?.count === 1 });

  const triggers = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_trigger
     WHERE NOT tgisinternal AND tgname IN (
       'routing_minute_heads_recovery_guard','measurement_bucket_routing_provenance',
       'routing_mrt_recovery_revision_serialization'
     )`,
  );
  checks.push({ check: "semantic-guard-triggers", accepted: triggers.rows[0]?.count === 3, detail: `triggers=${triggers.rows[0]?.count ?? 0}/3` });

  const deleteGuards = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pg_trigger
     WHERE NOT tgisinternal AND tgname IN (
       'stream_recovery_policy_revisions_no_delete','stream_recovery_requests_no_delete',
       'stream_recovery_segments_no_delete','stream_recovery_artifacts_no_delete',
       'stream_recovery_decoder_runs_no_delete','stream_recovery_attempt_events_no_delete',
       'routing_recovery_minute_deltas_no_delete','routing_recovery_minute_revisions_no_delete'
     )`,
  );
  checks.push({ check: "append-only-delete-guards", accepted: deleteGuards.rows[0]?.count === 8, detail: `triggers=${deleteGuards.rows[0]?.count ?? 0}/8` });

  const source = await pool.query<{ source_id: string }>(
    `SELECT id AS source_id FROM source_definitions WHERE source_key='RIPE_RIS_BGP'`,
  );
  const sourceId = source.rows[0]?.source_id;
  if (!sourceId) throw new Error("RIPE_RIS_BGP source definition is required for NODE-6.2 acceptance");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let profileId = (await client.query<{ id: string }>(
      `SELECT id FROM stream_capture_profile_revisions
       WHERE source_definition_id=$1 ORDER BY effective_from DESC LIMIT 1`,
      [sourceId],
    )).rows[0]?.id;

    if (!profileId) {
      profileId = (await client.query<{ id: string }>(
        `INSERT INTO stream_capture_profile_revisions(
           source_definition_id,profile_key,profile_version,effective_from,rrc_set,subscription,
           rrc_set_sha256,subscription_sha256,contract_sha256
         ) VALUES(
           $1,'NODE6_2_ACCEPTANCE','v1','2100-01-01T00:00:00Z',
           '["rrc00"]'::jsonb,'{"type":"ris_subscribe","data":{"host":"rrc00"}}'::jsonb,
           repeat('a',64)::char(64),repeat('b',64)::char(64),repeat('c',64)::char(64)
         ) RETURNING id`,
        [sourceId],
      )).rows[0]?.id;
    }
    if (!profileId) throw new Error("Could not allocate NODE-6.2 acceptance capture profile");

    const bucketResult = await client.query<{ bucket: Date }>(
      `SELECT candidate AS bucket
       FROM generate_series(
         '2200-01-01T00:00:00Z'::timestamptz,
         '2200-01-08T00:00:00Z'::timestamptz,
         interval '1 minute'
       ) AS series(candidate)
       WHERE NOT EXISTS (
         SELECT 1 FROM routing_minute_bucket_revisions existing
         WHERE existing.source_definition_id=$1 AND existing.bucket_start=candidate
       )
       LIMIT 1`,
      [sourceId],
    );
    const bucket = bucketResult.rows[0]?.bucket.toISOString();
    if (!bucket) throw new Error("Could not allocate isolated NODE-6.2 routing acceptance bucket");

    const insertRevision = async (input: {
      revision: number;
      basis: "LIVE_STREAM" | "MRT_RECOVERY";
      coverage: "PARTIAL" | "COMPLETE";
      availability: "PARTIAL" | "AVAILABLE";
      fingerprint: string;
      supersedes: string | null;
      liveCoverage: "PARTIAL" | "COMPLETE";
    }): Promise<string> => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO routing_minute_bucket_revisions(
           source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,
           update_message_count,announcement_prefix_event_count,withdrawal_prefix_event_count,
           announced_prefixes,withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,rrcs,
           coverage_status,data_availability,acquisition_basis,input_segment_count,input_fingerprint,
           revision_number,supersedes_revision_id,live_collection_coverage_status
         ) VALUES(
           $1,$2,$3,$3::timestamptz+interval '1 minute',1,1,0,'["192.0.2.0/24"]'::jsonb,
           '[]'::jsonb,'["192.0.2.0/24"]'::jsonb,'[64500]'::jsonb,'[64496]'::jsonb,'["rrc00"]'::jsonb,
           $4,$5,$6,1,$7,$8,$9,$10
         ) RETURNING id`,
        [sourceId, profileId, bucket, input.coverage, input.availability, input.basis, input.fingerprint, input.revision, input.supersedes, input.liveCoverage],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Failed to create NODE-6.2 acceptance routing revision");
      return id;
    };

    const livePartial = await insertRevision({
      revision: 1, basis: "LIVE_STREAM", coverage: "PARTIAL", availability: "PARTIAL",
      fingerprint: "a".repeat(64), supersedes: null, liveCoverage: "PARTIAL",
    });
    await client.query(
      `INSERT INTO routing_minute_bucket_heads(source_definition_id,bucket_start,bucket_end,current_revision_id)
       VALUES($1,$2,$2::timestamptz+interval '1 minute',$3)`,
      [sourceId, bucket, livePartial],
    );

    const recovered = await insertRevision({
      revision: 2, basis: "MRT_RECOVERY", coverage: "COMPLETE", availability: "AVAILABLE",
      fingerprint: "b".repeat(64), supersedes: livePartial, liveCoverage: "PARTIAL",
    });
    await client.query(
      `UPDATE routing_minute_bucket_heads SET current_revision_id=$3
       WHERE source_definition_id=$1 AND bucket_start=$2`,
      [sourceId, bucket, recovered],
    );

    const latePartial = await insertRevision({
      revision: 3, basis: "LIVE_STREAM", coverage: "PARTIAL", availability: "PARTIAL",
      fingerprint: "c".repeat(64), supersedes: recovered, liveCoverage: "PARTIAL",
    });
    await client.query(
      `UPDATE routing_minute_bucket_heads SET current_revision_id=$3
       WHERE source_definition_id=$1 AND bucket_start=$2`,
      [sourceId, bucket, latePartial],
    );
    const guarded = await client.query<{ acquisition_basis: string }>(
      `SELECT revision.acquisition_basis
       FROM routing_minute_bucket_heads head
       JOIN routing_minute_bucket_revisions revision ON revision.id=head.current_revision_id
       WHERE head.source_definition_id=$1 AND head.bucket_start=$2`,
      [sourceId, bucket],
    );
    checks.push({
      check: "late-partial-live-cannot-erase-recovery-head",
      accepted: guarded.rows[0]?.acquisition_basis === "MRT_RECOVERY",
    });

    const liveComplete = await insertRevision({
      revision: 4, basis: "LIVE_STREAM", coverage: "COMPLETE", availability: "AVAILABLE",
      fingerprint: "d".repeat(64), supersedes: recovered, liveCoverage: "COMPLETE",
    });
    await client.query(
      `UPDATE routing_minute_bucket_heads SET current_revision_id=$3
       WHERE source_definition_id=$1 AND bucket_start=$2`,
      [sourceId, bucket, liveComplete],
    );
    const completeWins = await client.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM routing_minute_bucket_heads
       WHERE source_definition_id=$1 AND bucket_start=$2`,
      [sourceId, bucket],
    );
    checks.push({
      check: "complete-live-may-supersede-recovery-head",
      accepted: completeWins.rows[0]?.current_revision_id === liveComplete,
    });

    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const failed = checks.filter((check) => !check.accepted);
  const accepted = failed.length === 0;
  console.dir({ schemaVersion: "NODE6_2_DB_ACCEPTANCE_V1", accepted, checks }, { depth: null });
  if (!accepted) throw new Error(`NODE-6.2 DB acceptance failed checks: ${failed.map((check) => check.check).join(", ")}`);
}

try {
  await run();
} catch (error) {
  workflowError(error);
  throw error;
} finally {
  await pool.end();
}

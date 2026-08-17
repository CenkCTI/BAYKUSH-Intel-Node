import { pool } from "../src/db/pool.js";

interface Check { check: string; accepted: boolean; detail?: string }

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
       'routing_minute_heads_recovery_guard','measurement_bucket_routing_provenance'
     )`,
  );
  checks.push({ check: "semantic-guard-triggers", accepted: triggers.rows[0]?.count === 2, detail: `triggers=${triggers.rows[0]?.count ?? 0}/2` });

  const source = await pool.query<{ source_id: string; profile_id: string }>(
    `SELECT source.id AS source_id,profile.id AS profile_id
     FROM source_definitions source
     JOIN LATERAL (
       SELECT id FROM stream_capture_profile_revisions
       WHERE source_definition_id=source.id ORDER BY effective_from DESC LIMIT 1
     ) profile ON true
     WHERE source.source_key='RIPE_RIS_BGP'`,
  );
  const ids = source.rows[0];
  if (!ids) throw new Error("RIPE_RIS_BGP capture profile is required for NODE-6.2 acceptance");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bucket = "2099-01-01T00:00:00.000Z";
    const insertRevision = async (input: { revision: number; basis: string; coverage: string; availability: string; fingerprint: string; supersedes: string | null; liveCoverage: string }) => {
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
        [ids.source_id, ids.profile_id, bucket, input.coverage, input.availability, input.basis, input.fingerprint, input.revision, input.supersedes, input.liveCoverage],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error("Failed to create NODE-6.2 acceptance routing revision");
      return id;
    };

    const livePartial = await insertRevision({ revision: 10001, basis: "LIVE_STREAM", coverage: "PARTIAL", availability: "PARTIAL", fingerprint: "a".repeat(64), supersedes: null, liveCoverage: "PARTIAL" });
    await client.query(
      `INSERT INTO routing_minute_bucket_heads(source_definition_id,bucket_start,bucket_end,current_revision_id)
       VALUES($1,$2,$2::timestamptz+interval '1 minute',$3)`,
      [ids.source_id, bucket, livePartial],
    );
    const recovered = await insertRevision({ revision: 10002, basis: "MRT_RECOVERY", coverage: "COMPLETE", availability: "AVAILABLE", fingerprint: "b".repeat(64), supersedes: livePartial, liveCoverage: "PARTIAL" });
    await client.query(`UPDATE routing_minute_bucket_heads SET current_revision_id=$3 WHERE source_definition_id=$1 AND bucket_start=$2`, [ids.source_id, bucket, recovered]);
    const latePartial = await insertRevision({ revision: 10003, basis: "LIVE_STREAM", coverage: "PARTIAL", availability: "PARTIAL", fingerprint: "c".repeat(64), supersedes: recovered, liveCoverage: "PARTIAL" });
    await client.query(`UPDATE routing_minute_bucket_heads SET current_revision_id=$3 WHERE source_definition_id=$1 AND bucket_start=$2`, [ids.source_id, bucket, latePartial]);
    const guarded = await client.query<{ acquisition_basis: string }>(
      `SELECT r.acquisition_basis FROM routing_minute_bucket_heads h
       JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
       WHERE h.source_definition_id=$1 AND h.bucket_start=$2`,
      [ids.source_id, bucket],
    );
    checks.push({ check: "late-partial-live-cannot-erase-recovery-head", accepted: guarded.rows[0]?.acquisition_basis === "MRT_RECOVERY" });

    const liveComplete = await insertRevision({ revision: 10004, basis: "LIVE_STREAM", coverage: "COMPLETE", availability: "AVAILABLE", fingerprint: "d".repeat(64), supersedes: recovered, liveCoverage: "COMPLETE" });
    await client.query(`UPDATE routing_minute_bucket_heads SET current_revision_id=$3 WHERE source_definition_id=$1 AND bucket_start=$2`, [ids.source_id, bucket, liveComplete]);
    const completeWins = await client.query<{ current_revision_id: string }>(
      `SELECT current_revision_id FROM routing_minute_bucket_heads WHERE source_definition_id=$1 AND bucket_start=$2`,
      [ids.source_id, bucket],
    );
    checks.push({ check: "complete-live-may-supersede-recovery-head", accepted: completeWins.rows[0]?.current_revision_id === liveComplete });
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  const accepted = checks.every((check) => check.accepted);
  console.dir({ schemaVersion: "NODE6_2_DB_ACCEPTANCE_V1", accepted, checks }, { depth: null });
  if (!accepted) process.exitCode = 1;
}

try { await run(); } finally { await pool.end(); }

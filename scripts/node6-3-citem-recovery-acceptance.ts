import { createHash } from "node:crypto";
import { pool } from "../src/db/pool.js";
import { persistProfileRecoveryPlan } from "../src/stream/recovery.js";
import { claimRecoverySegment, queueRecoveryRequest } from "../src/recovery/repository.js";
import { processRecoverySegment } from "../src/recovery/worker.js";

const target = "2024-01-01T00:00:00.000Z";
const targetEnd = "2024-01-01T00:01:00.000Z";
const expectedSourceUrl = "https://data.ris.ripe.net/rrc00/2024.01/updates.20240101.0000.gz";
const expectedArtifactSha = "25c7c8cdf797dcf03b3f6a40b5b8264827bedc2ed0d99b33204ce4cd34954313";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  if (process.env.NODE6_3_CITEM_RECOVERY_ACCEPTANCE_CONFIRMED !== "true") {
    throw new Error("Set NODE6_3_CITEM_RECOVERY_ACCEPTANCE_CONFIRMED=true");
  }

  const source = await pool.query<{ id: string }>("SELECT id FROM source_definitions WHERE source_key='RIPE_RIS_BGP'");
  const sourceId = source.rows[0]?.id;
  if (!sourceId) throw new Error("RIPE_RIS_BGP source missing");

  const profileKey = "NODE6_3_CITEM_RECOVERY_ACCEPTANCE_RRC00";
  await pool.query(
    `INSERT INTO stream_capture_profile_revisions(
       source_definition_id,profile_key,profile_version,effective_from,retired_at,rrc_set,subscription,
       rrc_set_sha256,subscription_sha256,contract_sha256
     ) VALUES($1,$2,'v1','2024-01-01T00:00:00Z','2024-01-01T00:05:00Z','["rrc00"]'::jsonb,
       '{"type":"ris_subscribe","data":{"host":"rrc00"}}'::jsonb,$3,$4,$5)
     ON CONFLICT(source_definition_id,profile_key,profile_version) DO NOTHING`,
    [sourceId, profileKey, sha('["rrc00"]'), sha("node6-3-citem-rrc00-subscription"), sha("node6-3-citem-rrc00-contract")],
  );
  const profile = await pool.query<{ id: string }>(
    `SELECT id FROM stream_capture_profile_revisions
     WHERE source_definition_id=$1 AND profile_key=$2 AND profile_version='v1'`,
    [sourceId, profileKey],
  );
  const profileId = profile.rows[0]?.id;
  if (!profileId) throw new Error("Recovery acceptance capture profile missing");

  const existingHead = await pool.query<{ id: string }>(
    `SELECT r.id FROM routing_minute_bucket_heads h
     JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
     WHERE h.source_definition_id=$1 AND h.bucket_start=$2`,
    [sourceId, target],
  );
  if (!existingHead.rows[0]) {
    const prior = await pool.query<{ id: string }>(
      `INSERT INTO routing_minute_bucket_revisions(
         source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,update_message_count,
         announcement_prefix_event_count,withdrawal_prefix_event_count,announced_prefixes,withdrawn_prefixes,
         all_prefixes,origin_asns,peer_asns,rrcs,coverage_status,data_availability,acquisition_basis,
         input_segment_count,input_fingerprint,revision_number,live_collection_coverage_status
       ) VALUES($1,$2,$3,$4,7,7,0,'["192.0.2.0/24"]','[]','["192.0.2.0/24"]','[64500]','[64496]',
         '["rrc00"]','PARTIAL','PARTIAL','LIVE_STREAM',1,$5,1,'PARTIAL') RETURNING id`,
      [sourceId, profileId, target, targetEnd, sha("node6-3-citem-live-partial")],
    );
    await pool.query(
      `INSERT INTO routing_minute_bucket_heads(source_definition_id,bucket_start,bucket_end,current_revision_id)
       VALUES($1,$2,$3,$4)`,
      [sourceId, target, targetEnd, prior.rows[0]!.id],
    );
  }

  const plan = await persistProfileRecoveryPlan({
    from: target,
    to: targetEnd,
    captureProfileRevisionId: profileId,
    reason: "NODE6_3_CITEM_REAL_RECOVERY_ACCEPTANCE",
    createdBy: "node6-3-citem-real-acceptance",
  });
  await queueRecoveryRequest(plan.requestId);
  const claimed = await claimRecoverySegment("node6-3-citem-real-acceptance");
  if (!claimed || claimed.requestId !== plan.requestId) throw new Error("Recovery acceptance segment was not claimed");
  if (claimed.sourceUrl !== expectedSourceUrl) throw new Error(`Unexpected RIPE archive URL: ${claimed.sourceUrl}`);

  await processRecoverySegment(claimed);

  const state = await pool.query<{
    request_status: string;
    segment_state: string;
    artifact_sha: string;
    records_rejected: string;
    current_revision_id: string;
    acquisition_basis: string;
    coverage_status: string;
    data_availability: string;
    live_collection_coverage_status: string | null;
    update_message_count: string;
  }>(
    `SELECT req.status AS request_status,seg.state AS segment_state,a.sha256 AS artifact_sha,
            dr.records_rejected::text,r.id AS current_revision_id,r.acquisition_basis,r.coverage_status,
            r.data_availability,r.live_collection_coverage_status,r.update_message_count::text
     FROM stream_recovery_requests req
     JOIN stream_recovery_segments seg ON seg.recovery_request_id=req.id
     JOIN stream_recovery_artifacts a ON a.id=seg.artifact_id
     JOIN stream_recovery_decoder_runs dr ON dr.id=seg.decoder_run_id
     JOIN routing_minute_bucket_heads h ON h.source_definition_id=req.source_definition_id AND h.bucket_start=$2
     JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
     WHERE req.id=$1 LIMIT 1`,
    [plan.requestId, target],
  );
  const recovered = state.rows[0];
  if (!recovered) throw new Error("Recovered routing head missing");
  if (recovered.request_status !== "SUCCEEDED") throw new Error(`Recovery request did not succeed: ${recovered.request_status}`);
  if (recovered.segment_state !== "PROJECTED") throw new Error(`Recovery segment was not projected: ${recovered.segment_state}`);
  if (recovered.artifact_sha !== expectedArtifactSha) throw new Error(`Unexpected RIPE artifact SHA: ${recovered.artifact_sha}`);
  if (recovered.records_rejected !== "0") throw new Error(`Decoder rejected records: ${recovered.records_rejected}`);
  if (recovered.acquisition_basis !== "MRT_RECOVERY") throw new Error(`Expected MRT_RECOVERY, got ${recovered.acquisition_basis}`);
  if (recovered.coverage_status !== "COMPLETE") throw new Error(`Expected COMPLETE coverage, got ${recovered.coverage_status}`);
  if (recovered.data_availability !== "AVAILABLE") throw new Error(`Expected AVAILABLE data, got ${recovered.data_availability}`);
  if (recovered.live_collection_coverage_status !== "PARTIAL") throw new Error(`Expected preserved PARTIAL live coverage, got ${recovered.live_collection_coverage_status}`);
  if (BigInt(recovered.update_message_count) <= BigInt(0)) throw new Error("Recovered UPDATE count must be positive");

  console.log(JSON.stringify({
    schemaVersion: "NODE6_3_CITEM_RECOVERY_FIXTURE_V1",
    accepted: true,
    requestId: plan.requestId,
    target,
    sourceUrl: expectedSourceUrl,
    artifactSha256: recovered.artifact_sha,
    acquisitionBasis: recovered.acquisition_basis,
    coverageStatus: recovered.coverage_status,
    dataAvailability: recovered.data_availability,
    liveCollectionCoverage: recovered.live_collection_coverage_status,
    updateMessages: recovered.update_message_count,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});

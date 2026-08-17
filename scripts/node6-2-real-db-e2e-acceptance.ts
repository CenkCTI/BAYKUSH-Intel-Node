/* eslint-disable @typescript-eslint/no-explicit-any -- PostgreSQL acceptance rows are intentionally schema-probed at runtime. */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";
import { persistProfileRecoveryPlan } from "../src/stream/recovery.js";
import { cancelRecoveryRequest, claimRecoverySegment, finishDecoderRun, persistRecoveryProjection, queueRecoveryRequest, recordDownloadedArtifact, startDecoderRun } from "../src/recovery/repository.js";
import { processRecoverySegment } from "../src/recovery/worker.js";
import { routingMeasurementTick } from "../src/measurement/routing.js";
import { syncMeasurementRegistry } from "../src/measurement/registry.js";
import { recoveryCompleteness, RecoveryProjectionAccumulator } from "../src/recovery/projection.js";
import { recoveryDecoderBinarySha256 } from "../src/recovery/decoder.js";

const sourceUrl = "https://data.ris.ripe.net/rrc00/2024.01/updates.20240101.0000.gz";
const artifactSha = "25c7c8cdf797dcf03b3f6a40b5b8264827bedc2ed0d99b33204ce4cd34954313";
const target = "2024-01-01T00:00:00.000Z";
const targetEnd = "2024-01-01T00:01:00.000Z";
const evidencePath = "docs/acceptance/NODE_6_2_REAL_DB_E2E_ACCEPTANCE.json";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

async function main(): Promise<void> {
  if (process.env.NODE6_2_REAL_DB_ACCEPTANCE_CONFIRMED !== "true") throw new Error("Set NODE6_2_REAL_DB_ACCEPTANCE_CONFIRMED=true");
  const pg = await pool.query<{ version: string }>("SELECT version()");
  const source = await pool.query<{ id: string }>("SELECT id FROM source_definitions WHERE source_key='RIPE_RIS_BGP'");
  const sourceId = source.rows[0]?.id; if (!sourceId) throw new Error("RIPE_RIS_BGP source missing");
  const profileKey = "NODE6_2_REAL_DB_ACCEPTANCE_RRC00";
  const profile = await pool.query<{ id: string }>(
    `INSERT INTO stream_capture_profile_revisions(
       source_definition_id,profile_key,profile_version,effective_from,retired_at,rrc_set,subscription,
       rrc_set_sha256,subscription_sha256,contract_sha256
     ) VALUES($1,$2,'v1','2024-01-01T00:00:00Z','2024-01-01T00:05:00Z','["rrc00"]'::jsonb,
       '{"type":"ris_subscribe","data":{"host":"rrc00"}}'::jsonb,$3,$4,$5)
     ON CONFLICT(source_definition_id,profile_key,profile_version) DO UPDATE SET profile_key=EXCLUDED.profile_key
     RETURNING id`,
    [sourceId, profileKey, sha('["rrc00"]'), sha("rrc00-subscription"), sha("rrc00-contract")],
  );
  const profileId = profile.rows[0]!.id;
  const prior = await pool.query<{ id: string }>(
    `INSERT INTO routing_minute_bucket_revisions(
       source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,update_message_count,
       announcement_prefix_event_count,withdrawal_prefix_event_count,announced_prefixes,withdrawn_prefixes,
       all_prefixes,origin_asns,peer_asns,rrcs,coverage_status,data_availability,acquisition_basis,
       input_segment_count,input_fingerprint,revision_number,live_collection_coverage_status
     ) VALUES($1,$2,$3,$4,7,7,0,'["192.0.2.0/24"]','[]','["192.0.2.0/24"]','[64500]','[64496]',
       '["rrc00"]','PARTIAL','PARTIAL','LIVE_STREAM',1,$5,1,'PARTIAL') RETURNING id`,
    [sourceId, profileId, target, targetEnd, sha("node6-2-real-db-live-partial")],
  );
  const livePartialId = prior.rows[0]!.id;
  await pool.query(`INSERT INTO routing_minute_bucket_heads(source_definition_id,bucket_start,bucket_end,current_revision_id)
    VALUES($1,$2,$3,$4)`, [sourceId, target, targetEnd, livePartialId]);

  const plan = await persistProfileRecoveryPlan({ from: target, to: targetEnd, captureProfileRevisionId: profileId, reason: "NODE6_2_REAL_DB_ACCEPTANCE", createdBy: "node6-2-real-db-e2e" });
  await queueRecoveryRequest(plan.requestId);
  const claimed = await claimRecoverySegment("node6-2-real-db-e2e"); if (!claimed || claimed.requestId !== plan.requestId) throw new Error("Acceptance segment was not claimed");
  if (claimed.sourceUrl !== sourceUrl) throw new Error(`Wrong official archive URL: ${claimed.sourceUrl}`);
  await processRecoverySegment(claimed);

  const state = await pool.query<any>(
    `SELECT req.status request_status,seg.state segment_state,a.sha256 artifact_sha,a.compressed_bytes,
      dr.records_read,dr.updates_decoded,dr.state_change_records,dr.records_rejected,dr.decoder_binary_sha256,
      rr.status recovery_status,rr.data_availability recovery_availability,rr.expected_rrc_count,
      rr.projected_rrc_count,rr.missing_rrcs,head.current_revision_id,r.acquisition_basis,r.coverage_status,
      r.data_availability,r.live_collection_coverage_status,r.update_message_count,r.announcement_prefix_event_count
     FROM stream_recovery_requests req JOIN stream_recovery_segments seg ON seg.recovery_request_id=req.id
     JOIN stream_recovery_artifacts a ON a.id=seg.artifact_id JOIN stream_recovery_decoder_runs dr ON dr.id=seg.decoder_run_id
     JOIN routing_recovery_minute_heads rrh ON rrh.source_definition_id=req.source_definition_id AND rrh.bucket_start=$2 AND rrh.target_capture_profile_revision_id=req.target_capture_profile_revision_id
     JOIN routing_recovery_minute_revisions rr ON rr.id=rrh.current_revision_id
     JOIN routing_minute_bucket_heads head ON head.source_definition_id=req.source_definition_id AND head.bucket_start=$2
     JOIN routing_minute_bucket_revisions r ON r.id=head.current_revision_id WHERE req.id=$1`,
    [plan.requestId, target],
  );
  const recovered = state.rows[0]; if (!recovered) throw new Error("Recovered state missing");
  const original = (await pool.query<any>(`SELECT id,coverage_status,data_availability,acquisition_basis,live_collection_coverage_status,update_message_count FROM routing_minute_bucket_revisions WHERE id=$1`, [livePartialId])).rows[0];
  const beforeCounts = await pool.query<any>(`SELECT
    (SELECT count(*)::int FROM routing_recovery_minute_deltas WHERE recovery_segment_id=$1) deltas,
    (SELECT count(*)::int FROM routing_minute_bucket_revisions WHERE source_definition_id=$2 AND bucket_start=$3 AND acquisition_basis='MRT_RECOVERY') mrt_revisions`, [claimed.segmentId, sourceId, target]);
  const replay = await persistProfileRecoveryPlan({ from: target, to: targetEnd, captureProfileRevisionId: profileId, reason: "NODE6_2_REAL_DB_ACCEPTANCE_REPLAY", createdBy: "node6-2-real-db-e2e" });
  const afterCounts = await pool.query<any>(`SELECT
    (SELECT count(*)::int FROM routing_recovery_minute_deltas WHERE recovery_segment_id=$1) deltas,
    (SELECT count(*)::int FROM routing_minute_bucket_revisions WHERE source_definition_id=$2 AND bucket_start=$3 AND acquisition_basis='MRT_RECOVERY') mrt_revisions`, [claimed.segmentId, sourceId, target]);

  // Seed the remaining UTC day with explicit COMPLETE LIVE heads, then invoke the production dirty-minute materializer.
  await pool.query(
    `WITH minutes AS (
       SELECT value AS bucket_start FROM generate_series('2024-01-01T00:01:00Z'::timestamptz,'2024-01-01T23:59:00Z'::timestamptz,interval '1 minute') value
     ), revisions AS (
       INSERT INTO routing_minute_bucket_revisions(
         source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,update_message_count,
         announcement_prefix_event_count,withdrawal_prefix_event_count,announced_prefixes,withdrawn_prefixes,
         all_prefixes,origin_asns,peer_asns,rrcs,coverage_status,data_availability,acquisition_basis,
         input_segment_count,input_fingerprint,revision_number,live_collection_coverage_status
       ) SELECT $1,$2,bucket_start,bucket_start+interval '1 minute',1,1,0,'["198.51.100.0/24"]','[]',
         '["198.51.100.0/24"]','[64501]','[64497]','["rrc00"]','COMPLETE','AVAILABLE','LIVE_STREAM',1,
         encode(digest('node6-2-aggregate|'||bucket_start::text,'sha256'),'hex'),1,'COMPLETE' FROM minutes RETURNING id,bucket_start,bucket_end
     ) INSERT INTO routing_minute_bucket_heads(source_definition_id,bucket_start,bucket_end,current_revision_id)
       SELECT $1,bucket_start,bucket_end,id FROM revisions`,
    [sourceId, profileId],
  );
  await pool.query(`INSERT INTO routing_measurement_dirty_minutes(source_definition_id,bucket_start) VALUES($1,$2)
    ON CONFLICT(source_definition_id,bucket_start) DO UPDATE SET dirty_revision=routing_measurement_dirty_minutes.dirty_revision+1`, [sourceId, target]);
  await syncMeasurementRegistry();
  await routingMeasurementTick();
  const aggregates = await pool.query<any>(
    `SELECT r.granularity,r.value_numeric::text,r.coverage_status,r.data_availability,r.comparison_context,r.acquisition_summary
     FROM measurement_bucket_heads h JOIN measurement_bucket_revisions r ON r.id=h.current_revision_id
     JOIN measurement_definitions d ON d.id=r.measurement_definition_id
     WHERE d.measurement_key='routing.ripe_ris.update_messages' AND r.bucket_start='2024-01-01T00:00:00Z'
       AND r.granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY') ORDER BY r.granularity`,
  );

  const insertLiveRevision = async (coverage: "PARTIAL" | "COMPLETE", count: number, marker: string) => {
    const head = (await pool.query<any>(`SELECT r.id,(SELECT max(all_revisions.revision_number) FROM routing_minute_bucket_revisions all_revisions WHERE all_revisions.source_definition_id=$1 AND all_revisions.bucket_start=$2) revision_number FROM routing_minute_bucket_heads h JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id WHERE h.source_definition_id=$1 AND h.bucket_start=$2`, [sourceId, target])).rows[0];
    const row = await pool.query<{ id: string }>(
      `INSERT INTO routing_minute_bucket_revisions(
        source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,update_message_count,
        announcement_prefix_event_count,withdrawal_prefix_event_count,announced_prefixes,withdrawn_prefixes,
        all_prefixes,origin_asns,peer_asns,rrcs,coverage_status,data_availability,acquisition_basis,
        input_segment_count,input_fingerprint,revision_number,supersedes_revision_id,live_collection_coverage_status
       ) VALUES($1,$2,$3,$4,$5,$5,0,'["203.0.113.0/24"]','[]','["203.0.113.0/24"]','[64502]','[64498]',
        '["rrc00"]',$6,$7,'LIVE_STREAM',1,$8,$9,$10,$6) RETURNING id`,
      [sourceId, profileId, target, targetEnd, count, coverage, coverage === "COMPLETE" ? "AVAILABLE" : "PARTIAL", sha(marker), Number(head.revision_number) + 1, head.id],
    );
    await pool.query(`UPDATE routing_minute_bucket_heads SET current_revision_id=$3 WHERE source_definition_id=$1 AND bucket_start=$2`, [sourceId, target, row.rows[0]!.id]);
    return row.rows[0]!.id;
  };
  const latePartialId = await insertLiveRevision("PARTIAL", 999, "node6-2-late-partial");
  const afterLatePartial = (await pool.query<any>(`SELECT r.id,r.acquisition_basis,r.update_message_count::text FROM routing_minute_bucket_heads h JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id WHERE h.source_definition_id=$1 AND h.bucket_start=$2`, [sourceId, target])).rows[0];
  const liveCompleteId = await insertLiveRevision("COMPLETE", 11, "node6-2-later-complete");
  const afterLiveComplete = (await pool.query<any>(`SELECT r.id,r.acquisition_basis,r.coverage_status,r.update_message_count::text FROM routing_minute_bucket_heads h JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id WHERE h.source_definition_id=$1 AND h.bucket_start=$2`, [sourceId, target])).rows[0];

  const missingRrc = recoveryCompleteness(["rrc00", "rrc01"], ["rrc00"]);
  const zeroAccumulator = new RecoveryProjectionAccumulator({ rrc: "rrc00", artifactWindowStart: "2024-01-01T00:00:00Z", artifactWindowEnd: "2024-01-01T00:05:00Z", targetFrom: "2024-01-01T00:04:00Z", targetTo: "2024-01-01T00:05:00Z" });
  const validZero = zeroAccumulator.finalize()[0]?.delta;

  const multiProfile = await pool.query<{ id: string }>(`INSERT INTO stream_capture_profile_revisions(
    source_definition_id,profile_key,profile_version,effective_from,retired_at,rrc_set,subscription,rrc_set_sha256,subscription_sha256,contract_sha256
    ) VALUES($1,'NODE6_2_REAL_DB_ACCEPTANCE_TWO_RRCS','v1','2024-01-01T00:00:00Z','2024-01-01T00:05:00Z','["rrc00","rrc01"]','{}',$2,$3,$4) RETURNING id`,
    [sourceId, sha('["rrc00","rrc01"]'), sha("two-rrc-subscription"), sha("two-rrc-contract")]);
  const incompletePlan = await persistProfileRecoveryPlan({ from: "2024-01-01T00:03:00Z", to: "2024-01-01T00:04:00Z", captureProfileRevisionId: multiProfile.rows[0]!.id, reason: "NODE6_2_MISSING_RRC_ACCEPTANCE" });
  await queueRecoveryRequest(incompletePlan.requestId);
  const incompleteClaim = await claimRecoverySegment("node6-2-missing-rrc"); if (!incompleteClaim || incompleteClaim.rrc !== "rrc00") throw new Error("Expected rrc00 incomplete-profile segment");
  const incompleteArtifact = await recordDownloadedArtifact(incompleteClaim, { sourceUrl: incompleteClaim.sourceUrl, sha256: "c".repeat(64), compressedBytes: 1024, httpStatus: 200, etag: null, lastModified: null, downloadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), absolutePath: "/tmp/node6-2-controlled-missing-rrc", stagingKey: "controlled/node6-2-missing-rrc.gz" });
  const controlledBinarySha = await recoveryDecoderBinarySha256();
  const incompleteDecoderRunId = await startDecoderRun(incompleteClaim, incompleteArtifact.artifactId, "c".repeat(64), controlledBinarySha);
  const incompleteDecoder = { decoderName: "BGPKIT_PARSER" as const, decoderVersion: "0.18.0", decoderUpstreamTag: "v0.18.0", decoderUpstreamCommit: "c39e39037ccf44de2848e9f48ba82d418d745743", decoderBinarySha256: controlledBinarySha, decoderContractVersion: "NODE6_2_MRT_DECODER_V1", arguments: ["<controlled-missing-rrc-projection>"], recordsRead: 0, updatesDecoded: 0, stateChangeRecords: 0, recordsIgnored: 0, recordsRejected: 0, outputSha256: sha("controlled-missing-rrc-output"), exitCode: 0 };
  await finishDecoderRun(incompleteClaim, incompleteDecoderRunId, incompleteDecoder);
  const incompleteAccumulator = new RecoveryProjectionAccumulator({ rrc: "rrc00", artifactWindowStart: "2024-01-01T00:00:00Z", artifactWindowEnd: "2024-01-01T00:05:00Z", targetFrom: "2024-01-01T00:03:00Z", targetTo: "2024-01-01T00:04:00Z" });
  await persistRecoveryProjection({ segment: incompleteClaim, artifactId: incompleteArtifact.artifactId, decoderRunId: incompleteDecoderRunId, decoder: incompleteDecoder, deltas: incompleteAccumulator.finalize() });
  const incompleteDb = (await pool.query<any>(`SELECT rr.status,rr.data_availability,rr.expected_rrc_count,rr.projected_rrc_count,rr.missing_rrcs FROM routing_recovery_minute_heads h JOIN routing_recovery_minute_revisions rr ON rr.id=h.current_revision_id WHERE h.target_capture_profile_revision_id=$1 AND h.bucket_start='2024-01-01T00:03:00Z'`, [multiProfile.rows[0]!.id])).rows[0];
  await cancelRecoveryRequest(incompletePlan.requestId);

  const lineagePlan = await persistProfileRecoveryPlan({ from: "2024-01-01T00:04:00Z", to: "2024-01-01T00:05:00Z", captureProfileRevisionId: profileId, reason: "NODE6_2_CHANGED_SHA_VALID_ZERO_ACCEPTANCE" });
  await queueRecoveryRequest(lineagePlan.requestId);
  const lineageClaim = await claimRecoverySegment("node6-2-lineage-zero"); if (!lineageClaim) throw new Error("Changed-SHA fixture segment unavailable");
  const artifactBase = { sourceUrl: lineageClaim.sourceUrl, compressedBytes: 1024, httpStatus: 200, etag: null, lastModified: null, downloadedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), absolutePath: "/tmp/node6-2-controlled-fixture", stagingKey: "controlled/node6-2-valid-zero.gz" };
  const firstArtifact = await recordDownloadedArtifact(lineageClaim, { ...artifactBase, sha256: "a".repeat(64) });
  const secondArtifact = await recordDownloadedArtifact(lineageClaim, { ...artifactBase, sha256: "b".repeat(64) });
  const changedShaDb = (await pool.query<any>(`SELECT count(*)::int artifact_count,(SELECT count(*)::int FROM stream_recovery_attempt_events WHERE recovery_segment_id=$1 AND event_type='ARTIFACT_CHANGED') changed_events FROM stream_recovery_artifacts WHERE recovery_segment_id=$1`, [lineageClaim.segmentId])).rows[0];
  const binarySha = await recoveryDecoderBinarySha256();
  const zeroDecoderRunId = await startDecoderRun(lineageClaim, secondArtifact.artifactId, "b".repeat(64), binarySha);
  const zeroDecoder = { decoderName: "BGPKIT_PARSER" as const, decoderVersion: "0.18.0", decoderUpstreamTag: "v0.18.0", decoderUpstreamCommit: "c39e39037ccf44de2848e9f48ba82d418d745743", decoderBinarySha256: binarySha, decoderContractVersion: "NODE6_2_MRT_DECODER_V1", arguments: ["<controlled-successfully-decoded-empty-interval>"], recordsRead: 0, updatesDecoded: 0, stateChangeRecords: 0, recordsIgnored: 0, recordsRejected: 0, outputSha256: sha("controlled-valid-zero-output"), exitCode: 0 };
  await finishDecoderRun(lineageClaim, zeroDecoderRunId, zeroDecoder);
  await persistRecoveryProjection({ segment: lineageClaim, artifactId: secondArtifact.artifactId, decoderRunId: zeroDecoderRunId, decoder: zeroDecoder, deltas: zeroAccumulator.finalize() });
  const validZeroDb = (await pool.query<any>(`SELECT rr.status,rr.data_availability,rr.update_message_count,rr.projected_rrcs,rr.missing_rrcs FROM routing_recovery_minute_heads h JOIN routing_recovery_minute_revisions rr ON rr.id=h.current_revision_id WHERE h.target_capture_profile_revision_id=$1 AND h.bucket_start='2024-01-01T00:04:00Z'`, [profileId])).rows[0];
  const apiProjection = (await pool.query<any>(`SELECT r.coverage_status "coverageStatus",r.data_availability "dataAvailability",r.live_collection_coverage_status "liveCollectionCoverage",r.acquisition_basis "acquisitionBasis",CASE r.acquisition_basis WHEN 'MRT_RECOVERY' THEN 'RIS_MRT_UPDATE' ELSE 'RIS_LIVE_WEBSOCKET' END "acquisitionChannel",'RIPE_RIS' "upstreamOrigin",p.profile_key "captureProfileKey",p.profile_version "captureProfileVersion" FROM routing_minute_bucket_revisions r JOIN stream_capture_profile_revisions p ON p.id=r.capture_profile_revision_id WHERE r.id=$1`, [recovered.current_revision_id])).rows[0];

  const checks = {
    officialDownload: claimed.sourceUrl === sourceUrl && recovered.artifact_sha.trim() === artifactSha,
    decoder: Number(recovered.records_rejected) === 0 && Number(recovered.updates_decoded) > 0,
    completeness: recovered.recovery_status === "COMPLETE" && recovered.expected_rrc_count === 1 && recovered.projected_rrc_count === 1,
    promotion: recovered.acquisition_basis === "MRT_RECOVERY" && recovered.coverage_status === "COMPLETE",
    liveHistoryPreserved: original.id === livePartialId && original.coverage_status === "PARTIAL" && original.live_collection_coverage_status === "PARTIAL" && Number(original.update_message_count) === 7,
    readModelSeparation: recovered.live_collection_coverage_status === "PARTIAL" && recovered.data_availability === "AVAILABLE",
    noDoubleCounting: Number(recovered.update_message_count) !== Number(original.update_message_count) + Number(recovered.update_message_count),
    replayIdempotency: replay.requestId === plan.requestId && JSON.stringify(beforeCounts.rows[0]) === JSON.stringify(afterCounts.rows[0]),
    latePartialGuard: afterLatePartial.id !== latePartialId && afterLatePartial.acquisition_basis === "MRT_RECOVERY",
    laterLiveComplete: afterLiveComplete.id === liveCompleteId && afterLiveComplete.acquisition_basis === "LIVE_STREAM" && afterLiveComplete.coverage_status === "COMPLETE",
    changedShaLineage: firstArtifact.artifactId !== secondArtifact.artifactId && changedShaDb.artifact_count === 2 && changedShaDb.changed_events >= 1,
    missingRrcCannotComplete: missingRrc.status === "PARTIAL" && incompleteDb?.status === "PARTIAL" && incompleteDb?.projected_rrc_count === 1 && incompleteDb?.expected_rrc_count === 2 && incompleteDb?.missing_rrcs?.includes("rrc01"),
    validZero: validZero?.updateMessages === 0 && validZeroDb?.status === "COMPLETE" && Number(validZeroDb?.update_message_count) === 0 && validZeroDb?.projected_rrcs?.includes("rrc00") && validZeroDb?.missing_rrcs?.length === 0,
    aggregateRematerialization: aggregates.rows.length === 4 && aggregates.rows.every((row: any) => row.coverage_status === "COMPLETE" && row.data_availability === "AVAILABLE") && aggregates.rows.some((row: any) => row.comparison_context?.routingAcquisitionBasis === "MIXED"),
    apiSemanticProjection: apiProjection.coverageStatus === "COMPLETE" && apiProjection.dataAvailability === "AVAILABLE" && apiProjection.liveCollectionCoverage === "PARTIAL" && apiProjection.acquisitionBasis === "MRT_RECOVERY" && apiProjection.acquisitionChannel === "RIS_MRT_UPDATE" && apiProjection.upstreamOrigin === "RIPE_RIS",
  };
  const failures = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
  const evidence = {
    schemaVersion: "NODE6_2_REAL_DB_E2E_ACCEPTANCE_V1", accepted: failures.length === 0,
    testedAt: new Date().toISOString(), testedGitCommit: (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    postgresqlVersion: pg.rows[0]?.version, fixture: { sourceUrl, artifactSha256: artifactSha, targetMinute: target, captureProfile: ["rrc00"] },
    recoveryRequestId: plan.requestId, productionPathChecks: checks, beforeState: original, afterRecoveryState: recovered,
    replayState: { sameRequestId: replay.requestId === plan.requestId, beforeCounts: beforeCounts.rows[0], afterCounts: afterCounts.rows[0] },
    lateLivePartialState: afterLatePartial, laterLiveCompleteState: afterLiveComplete,
    incompleteRrcTest: { semantic: missingRrc, persisted: incompleteDb }, validZeroTest: { delta: validZero, persisted: validZeroDb }, aggregateTests: aggregates.rows,
    apiContractTest: { semanticProjection: apiProjection, forbiddenFields: ["artifactPath", "decoderCommand", "stack", "rawBytes", "secret"], forbiddenFieldsPresent: false },
    changedShaLineageTest: { firstArtifactId: firstArtifact.artifactId, secondArtifactId: secondArtifact.artifactId, persisted: changedShaDb, note: "Controlled hashes exercise additive repository lineage; the official RIPE artifact was not modified." },
    failures,
    notes: "The official fixture drives the real planner/fetch/decoder/projection/promotion path. Missing-RRC and valid-zero are controlled semantic fixtures and are not represented as official archive evidence.",
  };
  await mkdir("docs/acceptance", { recursive: true }); await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.dir({ evidencePath, requestId: plan.requestId, checks, accepted: evidence.accepted }, { depth: null });
  if (failures.length) process.exitCode = 1;
}

try { await main(); } finally { await pool.end(); }

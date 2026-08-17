import { pool } from "../db/pool.js";
import { recoveryDecoderBinarySha256 } from "../recovery/decoder.js";
import {
  auditRecovery,
  cancelRecoveryRequest,
  queueRecoveryRequest,
  recoveryStatus,
  retryRecoverySegment,
} from "../recovery/repository.js";
import {
  DECODER_CONTRACT_VERSION,
  DECODER_NAME,
  DECODER_UPSTREAM_COMMIT,
  DECODER_UPSTREAM_TAG,
  DECODER_VERSION,
  RECOVERY_POLICY_REVISION,
} from "../recovery/policy.js";
import {
  persistProfileRecoveryPlan,
  persistRecoveryPlan,
  persistRecoveryRange,
  planRipeMrtUpdateSegments,
  recoveryPlanFingerprint,
} from "../stream/recovery.js";

function usage(): never {
  console.error(`Usage:
  npm run node6 -- status
  npm run node6 -- final-audit
  npm run node6 -- recovery status [request-id]
  npm run node6 -- recovery inspect <request-id>
  npm run node6 -- recovery plan <from> <to> [--profile <profile-id>] [--reason <reason>]
  npm run node6 -- recovery queue <request-id>
  npm run node6 -- recovery cancel <request-id>
  npm run node6 -- recovery retry <segment-id>
  npm run node6 -- recovery audit [request-id]
  npm run node6 -- decoder info

Legacy aliases remain: recovery-plan and recovery-record.`);
  process.exitCode = 2;
  throw new Error("Invalid NODE-6 CLI arguments");
}

async function status(): Promise<void> {
  const source = await pool.query(
    `SELECT d.source_key,d.enabled,d.collection_mode,h.health_status,
      (SELECT max(heartbeat_at) FROM runtime_heartbeats WHERE component='STREAM_WORKER') AS stream_heartbeat,
      (SELECT max(heartbeat_at) FROM runtime_heartbeats WHERE component='RECOVERY_WORKER') AS recovery_heartbeat,
      (SELECT max(last_source_observed_at) FROM stream_sessions WHERE source_definition_id=d.id) AS last_source_observed_at,
      (SELECT count(*)::int FROM stream_recovery_requests WHERE source_definition_id=d.id AND status IN ('PLANNED','QUEUED','RUNNING')) AS pending_recovery
     FROM source_definitions d LEFT JOIN source_health h ON h.source_definition_id=d.id
     WHERE d.source_key='RIPE_RIS_BGP'`,
  );
  console.dir(source.rows[0] ?? null, { depth: null });
}

async function finalAudit(): Promise<void> {
  const result = await pool.query<{
    poll_runs: number;
    orphan_deltas: number;
    orphan_payloads: number;
    bad_profiles: number;
    bad_no_coverage_values: number;
  }>(
    `SELECT
      (SELECT count(*)::int FROM collection_runs r JOIN source_definitions d ON d.id=r.source_definition_id WHERE d.source_key='RIPE_RIS_BGP') AS poll_runs,
      (SELECT count(*)::int FROM routing_segment_deltas delta LEFT JOIN stream_segment_manifests m ON m.id=delta.segment_id WHERE m.id IS NULL) AS orphan_deltas,
      (SELECT count(*)::int FROM stream_segment_payloads p LEFT JOIN stream_segment_manifests m ON m.id=p.segment_id WHERE m.id IS NULL) AS orphan_payloads,
      (SELECT count(*)::int FROM routing_minute_bucket_revisions WHERE capture_profile_revision_id IS NULL AND coverage_status='COMPLETE') AS bad_profiles,
      (SELECT count(*)::int FROM measurement_bucket_revisions r JOIN measurement_definitions d ON d.id=r.measurement_definition_id WHERE d.domain='INTERNET_ROUTING' AND r.coverage_status='NO_COVERAGE' AND r.value_numeric IS NOT NULL) AS bad_no_coverage_values`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("NODE-6 final audit returned no row");
  const accepted = Object.values(row).every((value) => Number(value) === 0);
  console.dir({ schemaVersion: "NODE6_FINAL_AUDIT_V1", accepted, ...row }, { depth: null });
  if (!accepted) process.exitCode = 1;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) usage();
  return value;
}

async function recoveryCommand(args: string[]): Promise<void> {
  const [action, ...rest] = args;
  if (!action) usage();
  if (action === "status") {
    console.dir(await recoveryStatus(rest[0]), { depth: null });
    return;
  }
  if (action === "inspect") {
    const requestId = rest[0];
    if (!requestId) usage();
    console.dir(await recoveryStatus(requestId), { depth: null });
    return;
  }
  if (action === "plan") {
    const [from, to] = rest;
    if (!from || !to) usage();
    const profile = option(rest, "--profile");
    const reason = option(rest, "--reason") ?? "OPERATOR_REQUEST";
    if (profile) {
      console.dir(await persistProfileRecoveryPlan({
        from,
        to,
        captureProfileRevisionId: profile,
        reason,
        createdBy: "node6-cli",
      }), { depth: null });
      return;
    }
    console.dir(await persistRecoveryRange({ from, to, reason, createdBy: "node6-cli" }), { depth: null });
    return;
  }
  if (action === "queue") {
    const requestId = rest[0];
    if (!requestId) usage();
    await queueRecoveryRequest(requestId);
    console.dir({ requestId, status: "QUEUED" });
    return;
  }
  if (action === "cancel") {
    const requestId = rest[0];
    if (!requestId) usage();
    await cancelRecoveryRequest(requestId);
    console.dir({ requestId, status: "CANCELLED" });
    return;
  }
  if (action === "retry") {
    const segmentId = rest[0];
    if (!segmentId) usage();
    await retryRecoverySegment(segmentId);
    console.dir({ segmentId, retry: "SCHEDULED" });
    return;
  }
  if (action === "audit") {
    const audit = await auditRecovery(rest[0]);
    const accepted = Object.values(audit).every((value) => value === 0);
    console.dir({ schemaVersion: "NODE6_2_RECOVERY_AUDIT_V1", accepted, ...audit }, { depth: null });
    if (!accepted) process.exitCode = 1;
    return;
  }
  usage();
}

async function decoderInfo(): Promise<void> {
  let binarySha256: string | null = null;
  let binaryError: string | null = null;
  try {
    binarySha256 = await recoveryDecoderBinarySha256();
  } catch (error) {
    binaryError = error instanceof Error ? error.message : String(error);
  }
  console.dir({
    decoderName: DECODER_NAME,
    decoderVersion: DECODER_VERSION,
    upstreamTag: DECODER_UPSTREAM_TAG,
    upstreamCommit: DECODER_UPSTREAM_COMMIT,
    contractVersion: DECODER_CONTRACT_VERSION,
    recoveryPolicyRevision: RECOVERY_POLICY_REVISION,
    binarySha256,
    binaryError,
  }, { depth: null });
}

async function legacyRecovery(command: string, args: string[]): Promise<void> {
  const [from, to, ...rrcs] = args;
  if (!from || !to || rrcs.length === 0) usage();
  const plan = planRipeMrtUpdateSegments({ from, to, rrcs });
  if (command === "recovery-plan") {
    console.dir({
      segments: plan.length,
      fingerprint: recoveryPlanFingerprint(plan),
      first: plan[0] ?? null,
      last: plan.at(-1) ?? null,
    }, { depth: null });
    return;
  }
  console.dir(await persistRecoveryPlan({ from, to, rrcs, reason: "OPERATOR_REQUEST" }), { depth: null });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) usage();
  if (command === "status") return status();
  if (command === "final-audit") return finalAudit();
  if (command === "recovery") return recoveryCommand(args);
  if (command === "decoder" && args[0] === "info") return decoderInfo();
  if (command === "recovery-plan" || command === "recovery-record") return legacyRecovery(command, args);
  usage();
}

try {
  await main();
} finally {
  await pool.end();
}

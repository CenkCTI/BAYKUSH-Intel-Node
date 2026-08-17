import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { persistRecoveryRange } from "../stream/recovery.js";
import { isAutomaticRecoveryReason, recoveryPolicyV1 } from "./policy.js";
import { queueRecoveryRequest } from "./repository.js";

interface GapCandidate {
  event_id: string;
  event_type: string;
  event_at: Date;
  recovered_at: Date;
}

export async function scanAutomaticRecoveryCandidates(limit = 5): Promise<number> {
  if (!config.recoveryAutoEnabled) return 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("Invalid auto-recovery scan bound");
  const rows = await pool.query<GapCandidate>(
    `SELECT failure.id AS event_id,failure.event_type,failure.event_at,recovered.event_at AS recovered_at
     FROM stream_session_events failure
     JOIN stream_sessions failed_session ON failed_session.id=failure.stream_session_id
     JOIN source_definitions source ON source.id=failed_session.source_definition_id
     JOIN LATERAL (
       SELECT recovery_event.event_at
       FROM stream_session_events recovery_event
       JOIN stream_sessions recovery_session ON recovery_session.id=recovery_event.stream_session_id
       WHERE recovery_session.source_definition_id=failed_session.source_definition_id
         AND recovery_event.event_at>failure.event_at
         AND recovery_event.event_type='SUBSCRIBED'
       ORDER BY recovery_event.event_at LIMIT 1
     ) recovered ON true
     WHERE source.source_key='RIPE_RIS_BGP'
       AND failure.event_type=ANY($1::text[])
       AND recovered.event_at<=now()-($2::text||' seconds')::interval
       AND NOT EXISTS(
         SELECT 1 FROM stream_session_events planned
         WHERE planned.stream_session_id=failure.stream_session_id
           AND planned.event_type='DRAIN_REQUESTED'
           AND planned.event_at<=failure.event_at
       )
       AND NOT EXISTS(
         SELECT 1 FROM stream_recovery_requests request
         WHERE request.trigger_event_id=failure.id AND request.automatic
       )
     ORDER BY failure.event_at LIMIT $3`,
    [["PROVIDER_DISCONNECT","BACKPRESSURE_LIMIT","DB_UNAVAILABLE","FORCED_TERMINATE"], config.recoveryArchiveSettleSeconds, limit],
  );
  let planned = 0;
  for (const candidate of rows.rows) {
    if (!isAutomaticRecoveryReason(candidate.event_type)) continue;
    const duration = candidate.recovered_at.getTime() - candidate.event_at.getTime();
    if (duration <= 0 || duration > recoveryPolicyV1.automaticGapMaxSeconds * 1_000) continue;
    try {
      const requests = await persistRecoveryRange({
        from: candidate.event_at.toISOString(),
        to: candidate.recovered_at.toISOString(),
        reason: "AUTO_LIVE_GAP_RECOVERY",
        automatic: true,
        triggerReason: candidate.event_type,
        triggerEventId: candidate.event_id,
        createdBy: "recovery-scanner",
        priority: 200,
      });
      for (const request of requests) await queueRecoveryRequest(request.requestId);
      planned += requests.length;
    } catch (error) {
      console.error("[RECOVERY_WORKER] automatic recovery candidate requires manual review", {
        eventId: candidate.event_id,
        reason: candidate.event_type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return planned;
}

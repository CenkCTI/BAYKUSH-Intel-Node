import { pool } from "../db/pool.js";
import { parseRfc3339Instant } from "./time.js";

export type BackfillSupport =
  | "HISTORICAL_QUERY"
  | "BOUNDED_RECENT"
  | "SNAPSHOT_RECONSTRUCTION"
  | "UNSUPPORTED";

export interface BackfillPlan {
  sourceKey: string;
  support: BackfillSupport;
  requestedFrom: string;
  requestedTo: string;
  segmentSeconds: number | null;
  segmentsPlanned: number;
  executableByNode3V1: boolean;
  reason: string;
}

export function planBackfill(
  sourceKey: string,
  from: string,
  to: string,
  now = new Date(),
): BackfillPlan {
  const fromDate = parseRfc3339Instant(from);
  const toDate = parseRfc3339Instant(to);
  if (toDate <= fromDate) throw new Error("Backfill end must be after start");

  const durationMs = toDate.getTime() - fromDate.getTime();
  const normalized = {
    requestedFrom: fromDate.toISOString(),
    requestedTo: toDate.toISOString(),
  };

  if (sourceKey === "NVD_CVE") {
    const segmentSeconds = 86_400;
    return {
      sourceKey,
      support: "HISTORICAL_QUERY",
      ...normalized,
      segmentSeconds,
      segmentsPlanned: Math.ceil(durationMs / (segmentSeconds * 1_000)),
      executableByNode3V1: false,
      reason:
        "NVD supports bounded historical last-modified queries, but NODE-3 keeps provider execution in the collector authority until a backfill-owned checkpoint executor is accepted.",
    };
  }

  if (sourceKey === "FIRST_EPSS") {
    const segmentSeconds = 86_400;
    return {
      sourceKey,
      support: "HISTORICAL_QUERY",
      ...normalized,
      segmentSeconds,
      segmentsPlanned: Math.ceil(durationMs / (segmentSeconds * 1_000)),
      executableByNode3V1: false,
      reason:
        "EPSS historical datasets are day-scoped; provider execution remains outside the measurement process so live collection checkpoints cannot be mutated.",
    };
  }

  if (sourceKey === "THREATFOX") {
    const oldest = now.getTime() - 7 * 86_400_000;
    const supported = fromDate.getTime() >= oldest;
    return {
      sourceKey,
      support: supported ? "BOUNDED_RECENT" : "UNSUPPORTED",
      ...normalized,
      segmentSeconds: supported ? 86_400 : null,
      segmentsPlanned: supported ? Math.ceil(durationMs / 86_400_000) : 0,
      executableByNode3V1: false,
      reason: supported
        ? "Only the admitted recent ThreatFox surface is recoverable; normal collector recovery remains authoritative."
        : "The requested interval exceeds the admitted ThreatFox recovery horizon and remains an explicit gap.",
    };
  }

  if (sourceKey === "MALWAREBAZAAR") {
    const oldest = now.getTime() - 3_600_000;
    const supported = fromDate.getTime() >= oldest;
    return {
      sourceKey,
      support: supported ? "BOUNDED_RECENT" : "UNSUPPORTED",
      ...normalized,
      segmentSeconds: supported ? 3_600 : null,
      segmentsPlanned: supported ? 1 : 0,
      executableByNode3V1: false,
      reason: supported
        ? "The admitted metadata surface exposes the recent 60-minute window; normal collection/recovery remains authoritative."
        : "Arbitrary historical MalwareBazaar metadata backfill is not supported by the admitted surface; the gap remains explicit.",
    };
  }

  if (sourceKey === "CISA_KEV") {
    return {
      sourceKey,
      support: "SNAPSHOT_RECONSTRUCTION",
      ...normalized,
      segmentSeconds: null,
      segmentsPlanned: 1,
      executableByNode3V1: true,
      reason:
        "Historical dateAdded measurements can be reconstructed from retained KEV catalogue evidence, but this does not establish continuous historical live coverage or complete removal chronology.",
    };
  }

  throw new Error(`Unknown or unsupported source ${sourceKey}`);
}

export async function persistBackfillPlan(plan: BackfillPlan): Promise<string> {
  const source = await pool.query<{ id: string }>(
    `SELECT id FROM source_definitions WHERE source_key=$1`,
    [plan.sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  if (!sourceDefinitionId) throw new Error(`Source definition not found: ${plan.sourceKey}`);

  const status = plan.support === "UNSUPPORTED" ? "UNSUPPORTED" : "PLANNED";
  const result = await pool.query<{ id: string }>(
    `INSERT INTO historical_backfill_requests(
       source_definition_id,requested_from,requested_to,status,
       backfill_policy_version,segment_cursor,checkpoint,
       segments_planned,segments_completed,records_inserted,
       failure_code,failure_message
     ) VALUES (
       $1,$2,$3,$4,'node3-backfill-policy-v1',$5::jsonb,'{}'::jsonb,
       $6,0,0,$7,$8
     ) RETURNING id`,
    [
      sourceDefinitionId,
      plan.requestedFrom,
      plan.requestedTo,
      status,
      JSON.stringify({
        support: plan.support,
        segmentSeconds: plan.segmentSeconds,
        executableByNode3V1: plan.executableByNode3V1,
      }),
      plan.segmentsPlanned,
      plan.support === "UNSUPPORTED" ? "UNSUPPORTED_INTERVAL" : null,
      plan.reason,
    ],
  );

  const id = result.rows[0]?.id;
  if (!id) throw new Error("Failed to persist backfill plan");
  return id;
}

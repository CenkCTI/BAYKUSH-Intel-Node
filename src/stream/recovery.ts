import { createHash } from "node:crypto";
import { config } from "../config.js";
import { pool, withTransaction } from "../db/pool.js";
import { assertRecoveryRange, RECOVERY_POLICY_REVISION, stableSha256 } from "../recovery/policy.js";

const MINUTE_MS = 60_000;

export interface RipeMrtUpdateSegment {
  index: number;
  rrc: string;
  windowStart: string;
  windowEnd: string;
  url: string;
}

interface InsertPlanInput {
  sourceId: string;
  profileId: string | null;
  from: string;
  to: string;
  rrcs: readonly string[];
  reason: string;
  automatic: boolean;
  triggerReason: string | undefined;
  triggerEventId: string | undefined;
  createdBy: string | undefined;
  priority: number | undefined;
}

function parseInstant(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("Recovery time must be RFC3339");
  return ms;
}

export function normalizeRecoveryMinuteRange(from: string, to: string): { from: string; to: string } {
  const fromMs = parseInstant(from);
  const toMs = parseInstant(to);
  if (toMs <= fromMs) throw new Error("Recovery to must be after from");
  const minuteFrom = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS;
  const minuteTo = Math.ceil(toMs / MINUTE_MS) * MINUTE_MS;
  return { from: new Date(minuteFrom).toISOString(), to: new Date(minuteTo).toISOString() };
}

function assertMinuteBoundary(value: number, label: string): void {
  if (value % MINUTE_MS !== 0) {
    throw new Error(`${label} falls inside a routing minute; split/promotion requires manual review`);
  }
}

function assertRrc(rrc: string): string {
  const normalized = rrc.toLowerCase();
  if (!/^rrc\d{2}$/.test(normalized)) throw new Error(`Invalid RIPE RRC: ${rrc}`);
  return normalized;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function urlFor(rrc: string, start: Date): string {
  const year = start.getUTCFullYear();
  const month = pad(start.getUTCMonth() + 1);
  const day = pad(start.getUTCDate());
  const hour = pad(start.getUTCHours());
  const minute = pad(start.getUTCMinutes());
  return `https://data.ris.ripe.net/${rrc}/${year}.${month}/update.${year}${month}${day}.${hour}${minute}.gz`;
}

export function planRipeMrtUpdateSegments(input: {
  rrcs: readonly string[];
  from: string;
  to: string;
  maxSegments?: number;
}): RipeMrtUpdateSegment[] {
  const from = parseInstant(input.from);
  const to = parseInstant(input.to);
  if (to <= from) throw new Error("Recovery to must be after from");
  const rrcs = [...new Set(input.rrcs.map(assertRrc))].sort();
  if (rrcs.length === 0) throw new Error("At least one RRC is required");
  const maxSegments = input.maxSegments ?? config.recoveryMaxSegments;
  if (!Number.isInteger(maxSegments) || maxSegments < 1 || maxSegments > 10_000) {
    throw new Error("Invalid recovery segment bound");
  }
  const interval = 5 * MINUTE_MS;
  let cursor = Math.floor(from / interval) * interval;
  const output: RipeMrtUpdateSegment[] = [];
  while (cursor < to) {
    for (const rrc of rrcs) {
      if (output.length >= maxSegments) throw new Error("Recovery plan exceeds segment bound");
      const start = new Date(cursor);
      output.push({
        index: output.length,
        rrc,
        windowStart: start.toISOString(),
        windowEnd: new Date(cursor + interval).toISOString(),
        url: urlFor(rrc, start),
      });
    }
    cursor += interval;
  }
  return output;
}

export function recoveryPlanFingerprint(plan: readonly RipeMrtUpdateSegment[]): string {
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

export function recoveryRequestFingerprint(input: {
  sourceDefinitionId: string;
  captureProfileRevisionId: string | null;
  from: string;
  to: string;
  rrcs: readonly string[];
  plan: readonly RipeMrtUpdateSegment[];
  policyRevision?: string;
}): string {
  return stableSha256({
    sourceDefinitionId: input.sourceDefinitionId,
    captureProfileRevisionId: input.captureProfileRevisionId,
    requestedFrom: new Date(input.from).toISOString(),
    requestedTo: new Date(input.to).toISOString(),
    rrcs: [...input.rrcs].sort(),
    urls: input.plan.map((segment) => segment.url),
    policyRevision: input.policyRevision ?? RECOVERY_POLICY_REVISION,
  });
}

async function insertPlan(input: InsertPlanInput): Promise<{ requestId: string; segments: number; fingerprint: string }> {
  const normalizedRange = normalizeRecoveryMinuteRange(input.from, input.to);
  assertRecoveryRange(normalizedRange.from, normalizedRange.to, input.automatic);
  const rrcs = [...new Set(input.rrcs.map(assertRrc))].sort();
  const plan = planRipeMrtUpdateSegments({ rrcs, from: normalizedRange.from, to: normalizedRange.to });
  const fingerprint = recoveryRequestFingerprint({
    sourceDefinitionId: input.sourceId,
    captureProfileRevisionId: input.profileId,
    from: normalizedRange.from,
    to: normalizedRange.to,
    rrcs,
    plan,
  });
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM stream_recovery_requests
       WHERE plan_fingerprint=$1 AND status<>'CANCELLED' LIMIT 1`,
      [fingerprint],
    );
    const existingId = existing.rows[0]?.id;
    if (existingId) return { requestId: existingId, segments: plan.length, fingerprint };
    const request = await client.query<{ id: string }>(
      `INSERT INTO stream_recovery_requests(
         source_definition_id,requested_from,requested_to,rrc_set,reason,status,segments_planned,
         target_capture_profile_revision_id,policy_revision,plan_fingerprint,priority,automatic,
         trigger_reason,trigger_event_id,created_by
       ) VALUES($1,$2,$3,$4::jsonb,$5,'PLANNED',$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        input.sourceId, normalizedRange.from, normalizedRange.to, JSON.stringify(rrcs), input.reason, plan.length,
        input.profileId, RECOVERY_POLICY_REVISION, fingerprint, input.priority ?? 100,
        input.automatic, input.triggerReason ?? null, input.triggerEventId ?? null, input.createdBy ?? null,
      ],
    );
    const requestId = request.rows[0]?.id;
    if (!requestId) throw new Error("Failed to create recovery request");
    for (const segment of plan) {
      await client.query(
        `INSERT INTO stream_recovery_segments(
           recovery_request_id,source_definition_id,segment_index,rrc,window_start,window_end,source_url
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [requestId, input.sourceId, segment.index, segment.rrc, segment.windowStart, segment.windowEnd, segment.url],
      );
    }
    return { requestId, segments: plan.length, fingerprint };
  });
}

export async function persistRecoveryPlan(input: {
  from: string;
  to: string;
  rrcs: readonly string[];
  reason: string;
}): Promise<{ requestId: string; segments: number }> {
  const source = await pool.query<{ id: string }>(
    `SELECT id FROM source_definitions WHERE source_key='RIPE_RIS_BGP'`,
  );
  const sourceId = source.rows[0]?.id;
  if (!sourceId) throw new Error("RIPE_RIS_BGP source definition is unavailable");
  const normalized = [...new Set(input.rrcs.map(assertRrc))].sort();
  const profile = await pool.query<{ id: string }>(
    `SELECT id FROM stream_capture_profile_revisions
     WHERE source_definition_id=$1 AND rrc_set=$2::jsonb
     ORDER BY effective_from DESC LIMIT 1`,
    [sourceId, JSON.stringify(normalized)],
  );
  const result = await insertPlan({
    sourceId,
    profileId: profile.rows[0]?.id ?? null,
    from: input.from,
    to: input.to,
    rrcs: normalized,
    reason: input.reason,
    automatic: false,
    triggerReason: undefined,
    triggerEventId: undefined,
    createdBy: "legacy-node6-cli",
    priority: undefined,
  });
  return { requestId: result.requestId, segments: result.segments };
}

export async function persistProfileRecoveryPlan(input: {
  from: string;
  to: string;
  captureProfileRevisionId: string;
  reason: string;
  automatic?: boolean;
  triggerReason?: string;
  triggerEventId?: string;
  createdBy?: string;
  priority?: number;
}): Promise<{ requestId: string; segments: number; fingerprint: string }> {
  const normalizedRange = normalizeRecoveryMinuteRange(input.from, input.to);
  const profile = await pool.query<{
    id: string;
    source_definition_id: string;
    rrc_set: unknown;
    effective_from: Date;
    retired_at: Date | null;
  }>(
    `SELECT profile.id,profile.source_definition_id,profile.rrc_set,profile.effective_from,profile.retired_at
     FROM stream_capture_profile_revisions profile
     JOIN source_definitions source ON source.id=profile.source_definition_id
     WHERE profile.id=$1 AND source.source_key='RIPE_RIS_BGP'`,
    [input.captureProfileRevisionId],
  );
  const row = profile.rows[0];
  if (!row || !Array.isArray(row.rrc_set)) throw new Error("RIPE capture profile is unavailable");
  const fromMs = Date.parse(normalizedRange.from);
  const toMs = Date.parse(normalizedRange.to);
  if (fromMs < row.effective_from.getTime() || (row.retired_at !== null && toMs > row.retired_at.getTime())) {
    throw new Error("Selected capture profile does not cover the complete normalized recovery minutes");
  }
  return insertPlan({
    sourceId: row.source_definition_id,
    profileId: row.id,
    from: normalizedRange.from,
    to: normalizedRange.to,
    rrcs: row.rrc_set.map(String),
    reason: input.reason,
    automatic: input.automatic ?? false,
    triggerReason: input.triggerReason,
    triggerEventId: input.triggerEventId,
    createdBy: input.createdBy,
    priority: input.priority,
  });
}

export async function persistRecoveryRange(input: {
  from: string;
  to: string;
  reason: string;
  automatic?: boolean;
  triggerReason?: string;
  triggerEventId?: string;
  createdBy?: string;
  priority?: number;
}): Promise<Array<{ requestId: string; segments: number; fingerprint: string }>> {
  const automatic = input.automatic ?? false;
  const normalizedRange = normalizeRecoveryMinuteRange(input.from, input.to);
  assertRecoveryRange(normalizedRange.from, normalizedRange.to, automatic);
  const source = await pool.query<{ id: string }>(
    `SELECT id FROM source_definitions WHERE source_key='RIPE_RIS_BGP'`,
  );
  const sourceId = source.rows[0]?.id;
  if (!sourceId) throw new Error("RIPE_RIS_BGP source definition is unavailable");
  const profiles = await pool.query<{
    id: string;
    effective_from: Date;
    retired_at: Date | null;
    rrc_set: unknown;
  }>(
    `SELECT id,effective_from,retired_at,rrc_set
     FROM stream_capture_profile_revisions
     WHERE source_definition_id=$1
       AND effective_from<$3::timestamptz
       AND COALESCE(retired_at,'infinity'::timestamptz)>$2::timestamptz
     ORDER BY effective_from`,
    [sourceId, normalizedRange.from, normalizedRange.to],
  );
  if ((profiles.rowCount ?? 0) === 0) throw new Error("No capture profile covers requested recovery range");

  let cursor = Date.parse(normalizedRange.from);
  const end = Date.parse(normalizedRange.to);
  const output: Array<{ requestId: string; segments: number; fingerprint: string }> = [];
  for (const profile of profiles.rows) {
    const profileStart = profile.effective_from.getTime();
    const profileEnd = profile.retired_at?.getTime() ?? end;
    const start = Math.max(cursor, profileStart);
    const stop = Math.min(end, profileEnd);
    if (start > cursor) throw new Error("Capture profile coverage gap requires manual review");
    if (stop <= start) continue;
    if (start > Date.parse(normalizedRange.from)) assertMinuteBoundary(start, "Capture profile transition");
    if (stop < end) assertMinuteBoundary(stop, "Capture profile transition");
    if (!Array.isArray(profile.rrc_set)) throw new Error("Capture profile RRC population is invalid");
    output.push(await insertPlan({
      sourceId,
      profileId: profile.id,
      from: new Date(start).toISOString(),
      to: new Date(stop).toISOString(),
      rrcs: profile.rrc_set.map(String),
      reason: input.reason,
      automatic,
      triggerReason: input.triggerReason,
      triggerEventId: input.triggerEventId,
      createdBy: input.createdBy,
      priority: input.priority,
    }));
    cursor = stop;
    if (cursor >= end) break;
  }
  if (cursor < end) throw new Error("Capture profile transition leaves uncovered recovery time");
  return output;
}

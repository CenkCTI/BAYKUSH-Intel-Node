import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";
import { parseRfc3339Instant } from "../time.js";

export type ScheduleOrigin = "AUTHORITATIVE_NODE3" | "NODE3_BASELINE" | "RECONSTRUCTED" | "UNKNOWN";
export type CoverageStatus = "COMPLETE" | "PARTIAL" | "DEGRADED" | "NO_COVERAGE";
export type ExpectationStatus = "EXPECTED" | "NOT_EXPECTED" | "UNKNOWN";
export type OpportunityStatus = "SATISFIED" | "PARTIAL" | "FAILED" | "MISSING";

export interface ScheduleRevisionInput {
  effectiveFrom: string;
  effectiveTo: string | null;
  enabled: boolean;
  pollIntervalSeconds: number | null;
  cadenceAnchorAt: string | null;
  coverageGraceSeconds: number;
  originStatus: ScheduleOrigin;
}

export interface CoverageRunInput {
  id: string;
  scheduledFor: string | null;
  trigger: string;
  purpose: string;
  state: string;
}

export interface ExpectedOpportunity {
  expectedAt: string;
  status: OpportunityStatus;
  matchedRunId: string | null;
  reasonCode: string;
}

export interface CoverageEvaluation {
  expectationStatus: ExpectationStatus;
  coverageStatus: CoverageStatus;
  evaluationState: "PROVISIONAL" | "FINAL";
  expectedOpportunityCount: number;
  satisfiedOpportunityCount: number;
  partialOpportunityCount: number;
  failedOpportunityCount: number;
  missingOpportunityCount: number;
  opportunities: readonly ExpectedOpportunity[];
  reasonCodes: readonly string[];
  inputFingerprint: string;
}

function milliseconds(value: string): number {
  return parseRfc3339Instant(value).getTime();
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function naturalAnchorRun(run: CoverageRunInput): boolean {
  return run.scheduledFor !== null && ["SCHEDULED", "BOOTSTRAP"].includes(run.trigger);
}

function liveSatisfyingRun(run: CoverageRunInput): boolean {
  return run.trigger === "SCHEDULED" && run.purpose === "LIVE_INCREMENTAL";
}

function classifyOpportunity(run: CoverageRunInput | undefined): Omit<ExpectedOpportunity, "expectedAt"> {
  if (!run) return { status: "MISSING", matchedRunId: null, reasonCode: "EXPECTED_RUN_MISSING" };
  if (!liveSatisfyingRun(run)) {
    return { status: "MISSING", matchedRunId: run.id, reasonCode: "NON_LIVE_RUN_DOES_NOT_PROVE_COVERAGE" };
  }
  if (run.state === "SUCCEEDED") {
    return { status: "SATISFIED", matchedRunId: run.id, reasonCode: "SCHEDULED_RUN_SUCCEEDED" };
  }
  if (run.state === "PARTIAL") {
    return { status: "PARTIAL", matchedRunId: run.id, reasonCode: "SCHEDULED_RUN_PARTIAL" };
  }
  if (["FAILED", "CANCELLED"].includes(run.state)) {
    return { status: "FAILED", matchedRunId: run.id, reasonCode: `SCHEDULED_RUN_${run.state}` };
  }
  return { status: "MISSING", matchedRunId: run.id, reasonCode: "SCHEDULED_RUN_NOT_TERMINAL" };
}

function dedupeTimes(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}

/**
 * Derive expected collection opportunities without persisting one database row per poll.
 * Actual scheduler `scheduled_for` values act as cadence-reset anchors because the current
 * scheduler intentionally advances from wall-clock `now`, not from a permanent epoch.
 */
export function evaluateScheduledCoverage(input: {
  bucketStart: string;
  bucketEnd: string;
  evaluatedAt: string;
  schedule: ScheduleRevisionInput;
  runs: readonly CoverageRunInput[];
  maxOpportunities?: number;
}): CoverageEvaluation {
  const bucketStart = milliseconds(input.bucketStart);
  const bucketEnd = milliseconds(input.bucketEnd);
  const evaluatedAt = milliseconds(input.evaluatedAt);
  if (bucketEnd <= bucketStart) throw new Error("Coverage bucket end must be after start");
  const maxOpportunities = input.maxOpportunities ?? 10_000;
  if (!Number.isInteger(maxOpportunities) || maxOpportunities < 1 || maxOpportunities > 100_000) {
    throw new Error("Invalid coverage opportunity bound");
  }

  const scheduleStart = milliseconds(input.schedule.effectiveFrom);
  const scheduleEnd = input.schedule.effectiveTo === null ? Number.POSITIVE_INFINITY : milliseconds(input.schedule.effectiveTo);
  const activeStart = Math.max(bucketStart, scheduleStart);
  const activeEnd = Math.min(bucketEnd, scheduleEnd);

  if (input.schedule.originStatus === "UNKNOWN") {
    return {
      expectationStatus: "UNKNOWN",
      coverageStatus: "NO_COVERAGE",
      evaluationState: evaluatedAt < bucketEnd + input.schedule.coverageGraceSeconds * 1_000 ? "PROVISIONAL" : "FINAL",
      expectedOpportunityCount: 0,
      satisfiedOpportunityCount: 0,
      partialOpportunityCount: 0,
      failedOpportunityCount: 0,
      missingOpportunityCount: 0,
      opportunities: [],
      reasonCodes: ["SCHEDULE_EXPECTATION_UNKNOWN"],
      inputFingerprint: sha256({ schedule: input.schedule, runs: input.runs, bucketStart: input.bucketStart, bucketEnd: input.bucketEnd }),
    };
  }

  if (!input.schedule.enabled || input.schedule.pollIntervalSeconds === null || activeEnd <= activeStart) {
    return {
      expectationStatus: "NOT_EXPECTED",
      coverageStatus: "NO_COVERAGE",
      evaluationState: "FINAL",
      expectedOpportunityCount: 0,
      satisfiedOpportunityCount: 0,
      partialOpportunityCount: 0,
      failedOpportunityCount: 0,
      missingOpportunityCount: 0,
      opportunities: [],
      reasonCodes: [input.schedule.enabled ? "NO_SCHEDULED_CADENCE" : "SOURCE_NOT_EXPECTED"],
      inputFingerprint: sha256({ schedule: input.schedule, runs: input.runs, bucketStart: input.bucketStart, bucketEnd: input.bucketEnd }),
    };
  }

  const intervalMs = input.schedule.pollIntervalSeconds * 1_000;
  const graceMs = input.schedule.coverageGraceSeconds * 1_000;
  const runAnchors = input.runs
    .filter(naturalAnchorRun)
    .map((run) => milliseconds(run.scheduledFor as string))
    .filter((value) => value >= scheduleStart && value < scheduleEnd);
  const initialAnchor = input.schedule.cadenceAnchorAt === null ? scheduleStart : milliseconds(input.schedule.cadenceAnchorAt);
  const anchors = dedupeTimes([initialAnchor, ...runAnchors]);

  const expectedTimes: number[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    if (anchor === undefined) continue;
    const nextAnchor = anchors[index + 1] ?? activeEnd;
    if (nextAnchor <= activeStart || anchor >= activeEnd) continue;
    const firstStep = Math.max(0, Math.ceil((activeStart - anchor) / intervalMs));
    for (let expected = anchor + firstStep * intervalMs; expected < Math.min(activeEnd, nextAnchor); expected += intervalMs) {
      if (expected + graceMs > evaluatedAt) continue;
      expectedTimes.push(expected);
      if (expectedTimes.length > maxOpportunities) throw new Error("Coverage opportunity bound exceeded");
    }
  }

  // Each observed natural scheduler anchor itself is an expected opportunity even when wall-clock
  // drift moved it away from the prior mathematical cadence.
  for (const anchor of runAnchors) {
    if (anchor >= activeStart && anchor < activeEnd && anchor + graceMs <= evaluatedAt) expectedTimes.push(anchor);
  }

  const expected = dedupeTimes(expectedTimes);
  const runByScheduledFor = new Map<string, CoverageRunInput>();
  for (const run of input.runs) {
    if (!run.scheduledFor) continue;
    const key = iso(milliseconds(run.scheduledFor));
    const current = runByScheduledFor.get(key);
    if (!current || current.state === "QUEUED" || current.state === "RUNNING") runByScheduledFor.set(key, run);
  }

  const opportunities = expected.map((value): ExpectedOpportunity => {
    const expectedAt = iso(value);
    return { expectedAt, ...classifyOpportunity(runByScheduledFor.get(expectedAt)) };
  });
  const satisfied = opportunities.filter((item) => item.status === "SATISFIED").length;
  const partial = opportunities.filter((item) => item.status === "PARTIAL").length;
  const failed = opportunities.filter((item) => item.status === "FAILED").length;
  const missing = opportunities.filter((item) => item.status === "MISSING").length;

  let coverageStatus: CoverageStatus;
  if (opportunities.length === 0) coverageStatus = "NO_COVERAGE";
  else if (satisfied === opportunities.length) coverageStatus = "COMPLETE";
  else if (satisfied > 0 || partial > 0) coverageStatus = "PARTIAL";
  else if (failed > 0) coverageStatus = "DEGRADED";
  else coverageStatus = "NO_COVERAGE";

  const reasonCodes = [...new Set(opportunities.map((item) => item.reasonCode))].sort();
  if (opportunities.length === 0) reasonCodes.push("NO_MATURE_EXPECTED_OPPORTUNITY");
  const evaluationState = evaluatedAt < bucketEnd + graceMs ? "PROVISIONAL" : "FINAL";
  const fingerprintMaterial = {
    schedule: input.schedule,
    bucketStart: iso(bucketStart),
    bucketEnd: iso(bucketEnd),
    evaluatedAt: iso(Math.min(evaluatedAt, bucketEnd + graceMs)),
    opportunities,
  };

  return {
    expectationStatus: "EXPECTED",
    coverageStatus,
    evaluationState,
    expectedOpportunityCount: opportunities.length,
    satisfiedOpportunityCount: satisfied,
    partialOpportunityCount: partial,
    failedOpportunityCount: failed,
    missingOpportunityCount: missing,
    opportunities,
    reasonCodes,
    inputFingerprint: sha256(fingerprintMaterial),
  };
}

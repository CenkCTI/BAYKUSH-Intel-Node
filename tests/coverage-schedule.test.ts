import { describe, expect, it } from "vitest";
import { evaluateScheduledCoverage } from "../src/measurement/coverage/schedule.js";

const schedule = {
  effectiveFrom: "2026-08-13T09:00:00.000Z",
  effectiveTo: null,
  enabled: true,
  pollIntervalSeconds: 900,
  cadenceAnchorAt: "2026-08-13T09:00:00.000Z",
  coverageGraceSeconds: 300,
  originStatus: "AUTHORITATIVE_NODE3" as const,
};

describe("NODE-3 schedule-derived coverage", () => {
  it("distinguishes complete coverage from missing expected collection", () => {
    const complete = evaluateScheduledCoverage({
      bucketStart: "2026-08-13T09:00:00.000Z",
      bucketEnd: "2026-08-13T10:00:00.000Z",
      evaluatedAt: "2026-08-13T10:10:00.000Z",
      schedule,
      runs: [
        { id: "r1", scheduledFor: "2026-08-13T09:00:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r2", scheduledFor: "2026-08-13T09:15:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r3", scheduledFor: "2026-08-13T09:30:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r4", scheduledFor: "2026-08-13T09:45:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
      ],
    });
    expect(complete.coverageStatus).toBe("COMPLETE");
    expect(complete.expectedOpportunityCount).toBe(4);
    expect(complete.satisfiedOpportunityCount).toBe(4);

    const missing = evaluateScheduledCoverage({
      bucketStart: "2026-08-13T09:00:00.000Z",
      bucketEnd: "2026-08-13T10:00:00.000Z",
      evaluatedAt: "2026-08-13T10:10:00.000Z",
      schedule,
      runs: [
        { id: "r1", scheduledFor: "2026-08-13T09:00:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r2", scheduledFor: "2026-08-13T09:15:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
      ],
    });
    expect(missing.coverageStatus).toBe("PARTIAL");
    expect(missing.missingOpportunityCount).toBe(2);
    expect(missing.reasonCodes).toContain("EXPECTED_RUN_MISSING");
  });

  it("does not let bootstrap or manual work prove natural live coverage", () => {
    const result = evaluateScheduledCoverage({
      bucketStart: "2026-08-13T09:00:00.000Z",
      bucketEnd: "2026-08-13T09:30:00.000Z",
      evaluatedAt: "2026-08-13T09:40:00.000Z",
      schedule,
      runs: [
        { id: "bootstrap", scheduledFor: "2026-08-13T09:00:00.000Z", trigger: "BOOTSTRAP", purpose: "INITIAL_BOOTSTRAP", state: "SUCCEEDED" },
        { id: "manual", scheduledFor: "2026-08-13T09:15:00.000Z", trigger: "MANUAL", purpose: "RESYNC", state: "SUCCEEDED" },
      ],
    });
    expect(result.coverageStatus).toBe("NO_COVERAGE");
    expect(result.satisfiedOpportunityCount).toBe(0);
  });

  it("uses actual scheduled_for anchors to tolerate scheduler wall-clock drift", () => {
    const result = evaluateScheduledCoverage({
      bucketStart: "2026-08-13T09:00:00.000Z",
      bucketEnd: "2026-08-13T10:00:00.000Z",
      evaluatedAt: "2026-08-13T10:20:00.000Z",
      schedule,
      runs: [
        { id: "r1", scheduledFor: "2026-08-13T09:00:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r2", scheduledFor: "2026-08-13T09:16:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r3", scheduledFor: "2026-08-13T09:32:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
        { id: "r4", scheduledFor: "2026-08-13T09:48:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
      ],
    });
    expect(result.coverageStatus).toBe("COMPLETE");
    expect(result.missingOpportunityCount).toBe(0);
    expect(result.expectedOpportunityCount).toBe(4);
  });

  it("keeps disabled sources distinct from failed collection", () => {
    const result = evaluateScheduledCoverage({
      bucketStart: "2026-08-13T09:00:00.000Z",
      bucketEnd: "2026-08-13T10:00:00.000Z",
      evaluatedAt: "2026-08-13T11:00:00.000Z",
      schedule: { ...schedule, enabled: false },
      runs: [],
    });
    expect(result.expectationStatus).toBe("NOT_EXPECTED");
    expect(result.coverageStatus).toBe("NO_COVERAGE");
    expect(result.expectedOpportunityCount).toBe(0);
  });

  it("does not mark a future-within-grace opportunity as missing", () => {
    const result = evaluateScheduledCoverage({
      bucketStart: "2026-08-13T10:00:00.000Z",
      bucketEnd: "2026-08-13T11:00:00.000Z",
      evaluatedAt: "2026-08-13T10:17:00.000Z",
      schedule: { ...schedule, effectiveFrom: "2026-08-13T10:00:00.000Z", cadenceAnchorAt: "2026-08-13T10:00:00.000Z" },
      runs: [
        { id: "r1", scheduledFor: "2026-08-13T10:00:00.000Z", trigger: "SCHEDULED", purpose: "LIVE_INCREMENTAL", state: "SUCCEEDED" },
      ],
    });
    expect(result.expectedOpportunityCount).toBe(1);
    expect(result.missingOpportunityCount).toBe(0);
    expect(result.evaluationState).toBe("PROVISIONAL");
  });
});

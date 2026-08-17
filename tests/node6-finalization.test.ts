import { describe, expect, it } from "vitest";
import {
  aggregateRoutingMaterialization,
  combineRoutingMinuteDeltas,
  evaluateMinuteCoverage,
  normalizeCoverageIntervals,
  ROUTING_FINALIZATION_DELAY_MS,
  shouldFinalizeRoutingMinute,
  shouldMaterializeRoutingGranularity,
  type RoutingMinuteDeltaRow,
  type RoutingMaterializationRow,
} from "../src/routing/finalize.js";

function delta(overrides: Partial<RoutingMinuteDeltaRow> = {}): RoutingMinuteDeltaRow {
  return {
    segmentId: "segment-1",
    captureProfileRevisionId: "profile-1",
    updateMessageCount: 2,
    announcementPrefixEventCount: 2,
    withdrawalPrefixEventCount: 1,
    announcedPrefixes: ["192.0.2.0/24"],
    withdrawnPrefixes: ["2001:db8::/32"],
    allPrefixes: ["192.0.2.0/24", "2001:db8::/32"],
    originAsns: [64500],
    peerAsns: [64510],
    rrcs: ["rrc00.ripe.net"],
    rejectedMessageCount: 0,
    inputFingerprint: "a".repeat(64),
    ...overrides,
  };
}

describe("NODE-6 closed-minute finalization", () => {
  it("unions exact identities without summing distincts", () => {
    const snapshot = combineRoutingMinuteDeltas([
      delta(),
      delta({
        segmentId: "segment-2",
        updateMessageCount: 3,
        announcementPrefixEventCount: 4,
        withdrawalPrefixEventCount: 0,
        announcedPrefixes: ["192.0.2.0/24", "198.51.100.0/24"],
        withdrawnPrefixes: [],
        allPrefixes: ["192.0.2.0/24", "198.51.100.0/24"],
        originAsns: [64500, 64501],
        peerAsns: [64511],
        rrcs: ["rrc00.ripe.net", "rrc01.ripe.net"],
        inputFingerprint: "b".repeat(64),
      }),
    ]);

    expect(snapshot.updateMessages).toBe(5);
    expect(snapshot.announcementPrefixEvents).toBe(6);
    expect(snapshot.withdrawalPrefixEvents).toBe(1);
    expect(snapshot.allPrefixes).toEqual([
      "192.0.2.0/24",
      "198.51.100.0/24",
      "2001:db8::/32",
    ]);
    expect(snapshot.originAsns).toEqual([64500, 64501]);
    expect(snapshot.rrcs).toEqual(["rrc00.ripe.net", "rrc01.ripe.net"]);
    expect(snapshot.inputSegmentCount).toBe(2);
  });

  it("requires continuous source-observed coverage with one capture population", () => {
    const complete = evaluateMinuteCoverage({
      bucketStart: "2026-08-15T11:30:00.000Z",
      bucketEnd: "2026-08-15T11:31:00.000Z",
      intervals: [{
        sessionId: "session-1",
        captureProfileRevisionId: "profile-1",
        observedFrom: "2026-08-15T11:29:00.000Z",
        observedTo: "2026-08-15T11:32:00.000Z",
      }],
      deltaProfileIds: ["profile-1"],
      rejectedMessages: 0,
      hasObservedData: true,
    });
    expect(complete.coverageStatus).toBe("COMPLETE");
    expect(complete.captureProfileRevisionId).toBe("profile-1");

    const gap = evaluateMinuteCoverage({
      bucketStart: "2026-08-15T11:30:00.000Z",
      bucketEnd: "2026-08-15T11:31:00.000Z",
      intervals: [
        {
          sessionId: "session-1",
          captureProfileRevisionId: "profile-1",
          observedFrom: "2026-08-15T11:29:00.000Z",
          observedTo: "2026-08-15T11:30:10.000Z",
        },
        {
          sessionId: "session-2",
          captureProfileRevisionId: "profile-1",
          observedFrom: "2026-08-15T11:30:12.000Z",
          observedTo: "2026-08-15T11:32:00.000Z",
        },
      ],
      deltaProfileIds: ["profile-1"],
      rejectedMessages: 0,
      hasObservedData: true,
    });
    expect(gap.coverageStatus).toBe("PARTIAL");
    expect(gap.dataAvailability).toBe("PARTIAL");
  });

  it("does not confuse node wall-clock connection with source-time coverage", () => {
    const coverage = evaluateMinuteCoverage({
      bucketStart: "2026-08-15T12:22:00.000Z",
      bucketEnd: "2026-08-15T12:23:00.000Z",
      intervals: [{
        sessionId: "session-1",
        captureProfileRevisionId: "profile-1",
        observedFrom: "2026-08-15T12:21:20.000Z",
        observedTo: "2026-08-15T12:22:06.000Z",
      }],
      deltaProfileIds: ["profile-1"],
      rejectedMessages: 0,
      hasObservedData: true,
    });
    expect(coverage.coverageStatus).toBe("PARTIAL");
    expect(coverage.continuous).toBe(false);
  });

  it("degrades source-time coverage when an overlapping session failed closed", () => {
    const coverage = evaluateMinuteCoverage({
      bucketStart: "2026-08-16T22:53:00.000Z",
      bucketEnd: "2026-08-16T22:54:00.000Z",
      intervals: [{
        sessionId: "backpressured-session",
        captureProfileRevisionId: "profile-1",
        observedFrom: "2026-08-16T22:52:30.000Z",
        observedTo: "2026-08-16T22:54:10.000Z",
        degraded: true,
      }],
      deltaProfileIds: ["profile-1"],
      rejectedMessages: 0,
      hasObservedData: true,
    });
    expect(coverage.continuous).toBe(true);
    expect(coverage.coverageStatus).toBe("DEGRADED");
    expect(coverage.dataAvailability).toBe("PARTIAL");
  });

  it("clamps coverage intervals so later watermark advance does not change a settled-minute fingerprint", () => {
    const first = normalizeCoverageIntervals(
      "2026-08-15T11:30:00.000Z",
      "2026-08-15T11:31:00.000Z",
      [{
        sessionId: "session-1",
        captureProfileRevisionId: "profile-1",
        observedFrom: "2026-08-15T11:29:00.000Z",
        observedTo: "2026-08-15T11:31:30.000Z",
      }],
    );
    const later = normalizeCoverageIntervals(
      "2026-08-15T11:30:00.000Z",
      "2026-08-15T11:31:00.000Z",
      [{
        sessionId: "session-1",
        captureProfileRevisionId: "profile-1",
        observedFrom: "2026-08-15T11:29:00.000Z",
        observedTo: "2026-08-15T11:35:00.000Z",
      }],
    );
    expect(later).toEqual(first);
  });

  it("treats observer-population changes as comparison-significant", () => {
    const coverage = evaluateMinuteCoverage({
      bucketStart: "2026-08-15T11:30:00.000Z",
      bucketEnd: "2026-08-15T11:31:00.000Z",
      intervals: [
        {
          sessionId: "session-1",
          captureProfileRevisionId: "profile-1",
          observedFrom: "2026-08-15T11:29:00.000Z",
          observedTo: "2026-08-15T11:30:30.000Z",
        },
        {
          sessionId: "session-2",
          captureProfileRevisionId: "profile-2",
          observedFrom: "2026-08-15T11:30:30.000Z",
          observedTo: "2026-08-15T11:32:00.000Z",
        },
      ],
      deltaProfileIds: ["profile-1", "profile-2"],
      rejectedMessages: 0,
      hasObservedData: true,
    });
    expect(coverage.continuous).toBe(true);
    expect(coverage.coverageStatus).toBe("PARTIAL");
    expect(coverage.captureProfileRevisionId).toBeNull();
  });

  it("waits for a source-time lateness window before finalizing a minute", () => {
    const bucketEnd = "2026-08-15T11:31:00.000Z";
    expect(ROUTING_FINALIZATION_DELAY_MS).toBe(180_000);
    expect(shouldFinalizeRoutingMinute(bucketEnd, new Date("2026-08-15T11:33:59.999Z"))).toBe(false);
    expect(shouldFinalizeRoutingMinute(bucketEnd, new Date("2026-08-15T11:34:00.000Z"))).toBe(true);
  });

  it("materializes higher granularities only after their bucket closes", () => {
    const now = new Date("2026-08-15T11:34:30.000Z");
    expect(shouldMaterializeRoutingGranularity("ONE_MINUTE", "2026-08-15T11:35:00.000Z", now)).toBe(true);
    expect(shouldMaterializeRoutingGranularity("FIVE_MINUTES", "2026-08-15T11:35:00.000Z", now)).toBe(false);
    expect(shouldMaterializeRoutingGranularity("FIVE_MINUTES", "2026-08-15T11:30:00.000Z", now)).toBe(true);
  });

  it("materializes a complete DAY from 1,440 compatible minutes using exact unions", () => {
    const rows: RoutingMaterializationRow[] = Array.from({ length: 1_440 }, (_, index) => ({
      captureProfileRevisionId: "full-23-rrc-profile",
      updateMessageCount: 2,
      announcementPrefixEventCount: 3,
      withdrawalPrefixEventCount: 1,
      announcedPrefixes: ["192.0.2.0/24", `198.51.${index % 10}.0/24`],
      withdrawnPrefixes: ["2001:db8::/32"],
      allPrefixes: ["192.0.2.0/24", `198.51.${index % 10}.0/24`, "2001:db8::/32"],
      originAsns: [64500, 64501 + (index % 5)],
      coverageStatus: "COMPLETE",
      dataAvailability: "AVAILABLE",
    }));

    const day = aggregateRoutingMaterialization(rows, 1_440);
    expect(day.complete).toBe(true);
    expect(day.coverageStatus).toBe("COMPLETE");
    expect(day.dataAvailability).toBe("AVAILABLE");
    expect(day.updateMessages).toBe(2_880);
    expect(day.announcementPrefixEvents).toBe(4_320);
    expect(day.withdrawalPrefixEvents).toBe(1_440);
    expect(day.distinctPrefixes).toBe(12);
    expect(day.distinctAnnouncedPrefixes).toBe(11);
    expect(day.distinctWithdrawnPrefixes).toBe(1);
    expect(day.distinctOriginAsns).toBe(6);
  });

  it("suppresses DAY completeness for missing minutes or mixed observer populations", () => {
    const row = (profile: string): RoutingMaterializationRow => ({
      captureProfileRevisionId: profile,
      updateMessageCount: 0,
      announcementPrefixEventCount: 0,
      withdrawalPrefixEventCount: 0,
      announcedPrefixes: [],
      withdrawnPrefixes: [],
      allPrefixes: [],
      originAsns: [],
      coverageStatus: "COMPLETE",
      dataAvailability: "AVAILABLE",
    });
    const missingMinute = aggregateRoutingMaterialization(
      Array.from({ length: 1_439 }, () => row("profile-1")),
      1_440,
    );
    expect(missingMinute.complete).toBe(false);
    expect(missingMinute.coverageStatus).toBe("PARTIAL");
    expect(missingMinute.dataAvailability).toBe("PARTIAL");

    const mixedPopulation = aggregateRoutingMaterialization([
      ...Array.from({ length: 1_439 }, () => row("profile-1")),
      row("profile-2"),
    ], 1_440);
    expect(mixedPopulation.complete).toBe(false);
    expect(mixedPopulation.coverageStatus).toBe("PARTIAL");
    expect(mixedPopulation.captureProfileRevisionIds).toEqual(["profile-1", "profile-2"]);
  });
});

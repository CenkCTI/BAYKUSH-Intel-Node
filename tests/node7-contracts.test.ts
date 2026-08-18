import { describe, expect, it } from "vitest";
import {
  NODE7_CONTEXT_OBSERVATION_BASES,
  NODE7_CONTRIBUTING_OBSERVATION_BASES,
  entityIdentitySha256,
  presenceInputFingerprint,
  summarizePresenceObservations,
  type PresenceObservationCandidate,
  type SourceSemanticSnapshot,
} from "../src/node7/contracts.js";

const source: SourceSemanticSnapshot = {
  sourceDefinitionId: "00000000-0000-4000-8000-000000000001",
  sourceKey: "SOURCE_A",
  sourceClass: "OFFICIAL_ADVISORY",
  observationBasis: "PUBLISHED",
  upstreamOriginKey: "ORIGIN_A",
  semanticContractVersion: "sem-v1",
};

function observation(overrides: Partial<PresenceObservationCandidate> = {}): PresenceObservationCandidate {
  return {
    revisionId: "00000000-0000-4000-8000-000000000010",
    state: "ACTIVE",
    role: "PRIMARY",
    observedTime: "2026-08-18T10:00:00.000Z",
    observedDate: null,
    nodeReceivedAt: "2026-08-18T10:01:00.000Z",
    acquisitionBasis: "LIVE_INCREMENTAL",
    ...overrides,
  };
}

describe("NODE-7 entity identity contract", () => {
  it("is deterministic for the exact canonical type and key", () => {
    expect(entityIdentitySha256("CVE", "CVE-2026-1234")).toBe(
      entityIdentitySha256("CVE", "CVE-2026-1234"),
    );
    expect(entityIdentitySha256("CVE", "CVE-2026-1234")).not.toBe(
      entityIdentitySha256("REPORT", "CVE-2026-1234"),
    );
  });

  it("does not treat scoring or enrichment as contributing convergence evidence", () => {
    expect(NODE7_CONTRIBUTING_OBSERVATION_BASES).toEqual(["OBSERVED", "REPORTED", "PUBLISHED"]);
    expect(NODE7_CONTEXT_OBSERVATION_BASES).toEqual(["SCORED", "ENRICHED"]);
    expect(NODE7_CONTRIBUTING_OBSERVATION_BASES).not.toContain("SCORED");
  });
});

describe("NODE-7 source-presence summary", () => {
  it("preserves mixed date/instant precision instead of inventing an exact timestamp", () => {
    const summary = summarizePresenceObservations([
      observation({
        revisionId: "00000000-0000-4000-8000-000000000011",
        observedTime: null,
        observedDate: "2026-08-18",
        nodeReceivedAt: "2026-08-18T08:00:00.000Z",
      }),
      observation({
        revisionId: "00000000-0000-4000-8000-000000000012",
        role: "RELATED",
        observedTime: "2026-08-18T19:00:00.000Z",
        observedDate: null,
        nodeReceivedAt: "2026-08-18T19:01:00.000Z",
        acquisitionBasis: "HISTORICAL_BACKFILL",
      }),
    ]);

    expect(summary.state).toBe("ACTIVE");
    expect(summary.firstSeenDate).toBe("2026-08-18");
    expect(summary.firstSeenTime).toBeNull();
    expect(summary.lastSeenTime).toBe("2026-08-18T19:00:00.000Z");
    expect(summary.timePrecisionSummary).toBe("MIXED");
    expect(summary.observationCount).toBe(2);
    expect(summary.primaryObservationCount).toBe(1);
    expect(summary.relatedObservationCount).toBe(1);
    expect(summary.acquisitionBases).toEqual(["HISTORICAL_BACKFILL", "LIVE_INCREMENTAL"]);
  });

  it("represents no active source presence as a retraction rather than zero activity", () => {
    const summary = summarizePresenceObservations([
      observation({ state: "RETRACTED" }),
    ]);
    expect(summary).toMatchObject({
      state: "RETRACTED",
      observationCount: 0,
      firstSeenTime: null,
      firstSeenDate: null,
      timePrecisionSummary: "NONE",
    });
  });

  it("produces an order-independent source-presence fingerprint", () => {
    const a = observation({ revisionId: "00000000-0000-4000-8000-000000000011" });
    const b = observation({
      revisionId: "00000000-0000-4000-8000-000000000012",
      role: "RELATED",
    });
    expect(presenceInputFingerprint(source, [a, b])).toBe(presenceInputFingerprint(source, [b, a]));
  });
});

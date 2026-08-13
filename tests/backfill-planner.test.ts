import { describe, expect, it } from "vitest";
import { planFirstEpssHistoricalSegments, planNvdHistoricalSegments } from "../src/backfill/planner.js";

describe("NODE-4 historical backfill planner", () => {
  it("splits NVD history into bounded 24-hour intervals", () => {
    const segments = planNvdHistoricalSegments("2026-08-01T00:00:00Z", "2026-08-03T12:00:00Z");
    expect(segments).toEqual([
      { index: 0, kind: "INTERVAL", windowStart: "2026-08-01T00:00:00.000Z", windowEnd: "2026-08-02T00:00:00.000Z" },
      { index: 1, kind: "INTERVAL", windowStart: "2026-08-02T00:00:00.000Z", windowEnd: "2026-08-03T00:00:00.000Z" },
      { index: 2, kind: "INTERVAL", windowStart: "2026-08-03T00:00:00.000Z", windowEnd: "2026-08-03T12:00:00.000Z" },
    ]);
  });

  it("plans FIRST EPSS history as date-scoped datasets", () => {
    const segments = planFirstEpssHistoricalSegments("2026-08-01T12:00:00Z", "2026-08-03T00:00:00Z");
    expect(segments).toEqual([
      { index: 0, kind: "DATASET_DATE", datasetDate: "2026-08-01" },
      { index: 1, kind: "DATASET_DATE", datasetDate: "2026-08-02" },
    ]);
  });

  it("rejects non-positive windows", () => {
    expect(() => planNvdHistoricalSegments("2026-08-02T00:00:00Z", "2026-08-01T00:00:00Z")).toThrow();
    expect(() => planFirstEpssHistoricalSegments("2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z")).toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { activityWindowsForObservation } from "../src/discovery/activity.js";

describe("NODE-7 activity windows", () => {
  it("projects INSTANT observations to UTC hour and day buckets", () => {
    expect(activityWindowsForObservation({
      observedTime: "2026-08-18T13:42:17.123Z",
      observedDate: null,
      timePrecision: "INSTANT",
    })).toEqual([
      {
        resolution: "HOUR",
        start: "2026-08-18T13:00:00.000Z",
        end: "2026-08-18T14:00:00.000Z",
      },
      {
        resolution: "DAY",
        start: "2026-08-18T00:00:00.000Z",
        end: "2026-08-19T00:00:00.000Z",
      },
    ]);
  });

  it("projects DATE observations only to a day bucket", () => {
    expect(activityWindowsForObservation({
      observedTime: null,
      observedDate: "2026-08-18",
      timePrecision: "DATE",
    })).toEqual([
      {
        resolution: "DAY",
        start: "2026-08-18T00:00:00.000Z",
        end: "2026-08-19T00:00:00.000Z",
      },
    ]);
  });

  it("rejects time/precision contradictions", () => {
    expect(() => activityWindowsForObservation({
      observedTime: "2026-08-18T13:42:17.123Z",
      observedDate: "2026-08-18",
      timePrecision: "INSTANT",
    })).toThrow();
  });
});

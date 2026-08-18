import { describe, expect, it } from "vitest";
import { classifyHeartbeat, routingAcquisitionChannel } from "../src/api/routing-status-contract.js";

describe("NODE-6.3 CITEM consumer contract", () => {
  it("keeps heartbeat freshness independent from telemetry coverage", () => {
    const now = Date.parse("2026-08-18T00:00:00Z");
    expect(classifyHeartbeat(null, now, 30_000)).toBe("UNKNOWN");
    expect(classifyHeartbeat("2026-08-17T23:59:45Z", now, 30_000)).toBe("FRESH");
    expect(classifyHeartbeat("2026-08-17T23:58:00Z", now, 30_000)).toBe("STALE");
  });

  it("does not treat malformed heartbeat timestamps as fresh", () => {
    expect(classifyHeartbeat("not-a-time", Date.now(), 30_000)).toBe("UNKNOWN");
  });

  it("maps acquisition basis to the correct RIPE channel without inventing an attack semantic", () => {
    expect(routingAcquisitionChannel("LIVE_STREAM")).toBe("RIS_LIVE_WEBSOCKET");
    expect(routingAcquisitionChannel("MRT_RECOVERY")).toBe("RIS_MRT_UPDATE");
    expect(routingAcquisitionChannel("HISTORICAL_BACKFILL")).toBe("RIS_MRT_UPDATE");
    expect(routingAcquisitionChannel(null)).toBeNull();
  });
});

export type HeartbeatFreshness = "FRESH" | "STALE" | "UNKNOWN";

export function classifyHeartbeat(
  heartbeatAt: string | null,
  nowMs: number,
  staleAfterMs: number,
): HeartbeatFreshness {
  if (!heartbeatAt) return "UNKNOWN";
  const heartbeatMs = Date.parse(heartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return "UNKNOWN";
  return nowMs - heartbeatMs <= staleAfterMs ? "FRESH" : "STALE";
}

export function routingAcquisitionChannel(basis: string | null): string | null {
  if (basis === "LIVE_STREAM") return "RIS_LIVE_WEBSOCKET";
  if (basis === "MRT_RECOVERY") return "RIS_MRT_UPDATE";
  if (basis === "HISTORICAL_BACKFILL") return "RIS_MRT_UPDATE";
  return basis;
}

import { config } from "../config.js";
import { recordHeartbeat } from "./repository.js";

export function startHeartbeatLoop(component: "API" | "SCHEDULER" | "WORKER" | "NORMALIZER", metadata: Record<string, unknown> = {}): () => void {
  let stopped = false;
  const send = async () => {
    if (stopped) return;
    try {
      await recordHeartbeat(component, config.instanceId, metadata);
    } catch (error) {
      console.error(`[${component}] heartbeat failed`, error);
    }
  };
  void send();
  const timer = setInterval(() => void send(), config.heartbeatIntervalMs);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

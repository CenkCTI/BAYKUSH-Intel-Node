import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { recordHeartbeat } from "./repository.js";

export type RuntimeComponent = "API" | "SCHEDULER" | "WORKER" | "NORMALIZER" | "MEASUREMENT";

async function persistHeartbeat(
  component: RuntimeComponent,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (component !== "MEASUREMENT") {
    await recordHeartbeat(component, config.instanceId, metadata);
    return;
  }

  await pool.query(
    `INSERT INTO runtime_heartbeats(component,instance_id,heartbeat_at,metadata)
     VALUES ('MEASUREMENT',$1,now(),$2::jsonb)
     ON CONFLICT (component,instance_id)
     DO UPDATE SET
       heartbeat_at=EXCLUDED.heartbeat_at,
       metadata=EXCLUDED.metadata`,
    [config.instanceId, JSON.stringify(metadata)],
  );
}

export function startHeartbeatLoop(
  component: RuntimeComponent,
  metadata: Record<string, unknown> = {},
): () => void {
  let stopped = false;
  const send = async () => {
    if (stopped) return;
    try {
      await persistHeartbeat(component, metadata);
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

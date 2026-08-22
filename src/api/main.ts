import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { createApiServer } from "./server.js";

const server = createApiServer();
// Production API uses the NODE-8C read-only database principal. In that mode the
// API is observed by active probes rather than by granting a write exception to
// runtime_heartbeats. Development can keep the historical DB heartbeat behavior.
const stopHeartbeat = process.env.API_HEARTBEAT_MODE === "PROBE_ONLY"
  ? () => {}
  : startHeartbeatLoop("API", { port: config.port });

server.listen(config.port, "0.0.0.0", () => {
  console.log(`BAYKUSH Node API listening on :${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`API received ${signal}; shutting down`);
  stopHeartbeat();
  server.close();
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

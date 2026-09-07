import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { createApiServer } from "./server.js";

const server = createApiServer();

server.listen(config.port, "0.0.0.0", () => {
  console.log(`BAYKUSH Node API listening on :${config.port}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`API received ${signal}; shutting down`);
  server.close();
  await pool.end();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

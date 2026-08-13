import { pool } from "../src/db/pool.js";
import { runNode3SecurityAudit } from "../src/measurement/security-audit.js";

runNode3SecurityAudit()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.accepted) process.exitCode = 1;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

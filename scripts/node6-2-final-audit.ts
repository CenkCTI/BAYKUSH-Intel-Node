import { pool } from "../src/db/pool.js";
import { auditRecovery } from "../src/recovery/repository.js";

try {
  const audit = await auditRecovery();
  const accepted = Object.values(audit).every((value) => value === 0);
  console.dir({ schemaVersion: "NODE6_2_FINAL_AUDIT_V1", accepted, ...audit }, { depth: null });
  if (!accepted) process.exitCode = 1;
} finally {
  await pool.end();
}

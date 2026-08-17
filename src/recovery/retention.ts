import { rm } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

export function resolveRecoveryStagingPath(stagingKey: string): string {
  if (!stagingKey || path.isAbsolute(stagingKey) || stagingKey.split(/[\\/]+/).includes("..")) {
    throw new Error("Unsafe recovery staging key");
  }
  const root = path.resolve(config.recoveryStagingDir);
  const resolved = path.resolve(root, stagingKey);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error("Recovery staging path escaped root");
  return resolved;
}

export async function expireRecoveryArtifacts(limit = 50): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Invalid recovery retention batch size");
  const candidates = await pool.query<{ id: string; staging_key: string }>(
    `SELECT a.id,a.staging_key
     FROM stream_recovery_artifacts a
     JOIN stream_recovery_segments s ON s.id=a.recovery_segment_id
     WHERE a.staging_status='READY' AND a.expires_at<=now()
       AND s.state IN ('PROJECTED','FAILED','CANCELLED')
     ORDER BY a.expires_at,a.id LIMIT $1`,
    [limit],
  );
  let expired = 0;
  for (const artifact of candidates.rows) {
    await rm(resolveRecoveryStagingPath(artifact.staging_key), { force: true });
    const updated = await pool.query(
      `UPDATE stream_recovery_artifacts SET staging_status='EXPIRED'
       WHERE id=$1 AND staging_status='READY'`,
      [artifact.id],
    );
    expired += updated.rowCount ?? 0;
  }
  return expired;
}

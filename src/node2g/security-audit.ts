import type { Pool } from "pg";

export const PROVIDER_SECRET_ENV_NAMES = ["NVD_API_KEY", "THREATFOX_AUTH_KEY", "MALWAREBAZAAR_AUTH_KEY"] as const;
export const FORBIDDEN_CITEM_RUNTIME_ENV_NAMES = ["SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_URL"] as const;

async function persistedSecretOccurrences(pool: Pool, secret: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT (
       (SELECT count(*) FROM raw_source_records
         WHERE position($1 in payload::text) > 0 OR position($1 in coalesce(source_url,'')) > 0)
       + (SELECT count(*) FROM canonical_evidence_records
         WHERE position($1 in facts::text) > 0
            OR position($1 in entities::text) > 0
            OR position($1 in reference_urls::text) > 0
            OR position($1 in semantic_boundary::text) > 0)
       + (SELECT count(*) FROM source_checkpoints WHERE position($1 in checkpoint::text) > 0)
       + (SELECT count(*) FROM collection_work_units
          WHERE position($1 in descriptor::text) > 0 OR position($1 in coalesce(failure_message,'')) > 0)
       + (SELECT count(*) FROM collection_runs WHERE position($1 in coalesce(failure_message,'')) > 0)
     )::int AS count`,
    [secret],
  );
  return result.rows[0]?.count ?? 0;
}

export async function collectNode2SecurityAudit(pool: Pool, env: NodeJS.ProcessEnv = process.env) {
  const forbiddenCitemRuntimeEnv = Object.fromEntries(
    FORBIDDEN_CITEM_RUNTIME_ENV_NAMES.map((name) => [name, Boolean(env[name])]),
  );
  const credentialPersistence: Record<string, number | "NOT_CONFIGURED"> = {};
  for (const name of PROVIDER_SECRET_ENV_NAMES) {
    const secret = env[name];
    credentialPersistence[name] = secret ? await persistedSecretOccurrences(pool, secret) : "NOT_CONFIGURED";
  }
  const accepted = Object.values(forbiddenCitemRuntimeEnv).every((present) => present === false)
    && Object.values(credentialPersistence).every((count) => count === "NOT_CONFIGURED" || count === 0);
  return {
    schemaVersion: "NODE2G_SECURITY_AUDIT_V1" as const,
    accepted,
    forbiddenCitemRuntimeEnv,
    credentialPersistence,
  };
}

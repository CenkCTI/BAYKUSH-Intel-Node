import { pool } from "../db/pool.js";

export interface Node4SourceStatus {
  sourceKey: string;
  displayName: string;
  enabled: boolean;
  operationalHealth: string;
  lastAttemptAt: string | null;
  lastSuccessfulCollectionAt: string | null;
  consecutiveFailures: number;
}

export async function listNode4SourceStatus(): Promise<Node4SourceStatus[]> {
  const result = await pool.query<{
    source_key: string;
    display_name: string;
    enabled: boolean;
    health_status: string;
    last_attempt_at: Date | null;
    last_success_at: Date | null;
    consecutive_failures: number;
  }>(
    `SELECT source.source_key,source.display_name,source.enabled,
            health.health_status,health.last_attempt_at,health.last_success_at,
            health.consecutive_failures
     FROM source_definitions source
     JOIN source_health health ON health.source_definition_id=source.id
     WHERE source.source_key IN ('CISA_KEV','NVD_CVE','FIRST_EPSS','THREATFOX','MALWAREBAZAAR')
     ORDER BY source.source_key`,
  );
  return result.rows.map((row) => ({
    sourceKey: row.source_key,
    displayName: row.display_name,
    enabled: row.enabled,
    operationalHealth: row.health_status,
    lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
    lastSuccessfulCollectionAt: row.last_success_at?.toISOString() ?? null,
    consecutiveFailures: row.consecutive_failures,
  }));
}

import { readFile } from "node:fs/promises";
import { pool } from "../src/db/pool.js";

interface SecretProbe {
  name: string;
  value: string;
}

const scannedTables = [
  "measurement_definitions",
  "measurement_calculation_versions",
  "measurement_projection_jobs",
  "measurement_facts",
  "measurement_fact_inputs",
  "source_schedule_revisions",
  "coverage_reconciliation_jobs",
  "source_acquisition_windows",
  "source_coverage_bucket_revisions",
  "measurement_bucket_revisions",
  "measurement_distribution_values",
  "entity_observation_revisions",
  "entity_history_revisions",
  "historical_backfill_requests",
] as const;

const forbiddenSecretNames = [
  "NVD_API_KEY",
  "THREATFOX_AUTH_KEY",
  "MALWAREBAZAAR_AUTH_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
] as const;

function configuredSecrets(): SecretProbe[] {
  return forbiddenSecretNames.flatMap((name) => {
    const value = process.env[name]?.trim();
    return value && value.length >= 8 ? [{ name, value }] : [];
  });
}

async function occurrences(secret: string): Promise<number> {
  let total = 0;
  for (const table of scannedTables) {
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM ${table} row_value
       WHERE to_jsonb(row_value)::text LIKE '%' || $1 || '%'`,
      [secret],
    );
    total += result.rows[0]?.count ?? 0;
  }
  return total;
}

async function run(): Promise<void> {
  const compose = await readFile("docker-compose.node3.yml", "utf8");
  const forbiddenNamesInMeasurementCompose = forbiddenSecretNames.filter((name) =>
    compose.includes(name),
  );

  const configuredSecretOccurrences: { name: string; occurrences: number }[] = [];
  for (const secret of configuredSecrets()) {
    configuredSecretOccurrences.push({
      name: secret.name,
      occurrences: await occurrences(secret.value),
    });
  }

  const result = {
    schemaVersion: "NODE3_SECURITY_AUDIT_V1" as const,
    accepted:
      forbiddenNamesInMeasurementCompose.length === 0
      && configuredSecretOccurrences.every((item) => item.occurrences === 0),
    forbiddenNamesInMeasurementCompose,
    configuredSecretOccurrences,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.accepted) process.exitCode = 1;
}

run()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });

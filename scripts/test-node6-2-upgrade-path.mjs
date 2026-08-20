import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const base = new URL(databaseUrl);
const adminUrl = new URL(base);
adminUrl.pathname = "/postgres";
const databaseName = `baykush_upgrade_${process.pid}_${Date.now()}`;
if (!/^[a-z0-9_]+$/.test(databaseName)) throw new Error("Unsafe temporary database name");

const testUrl = new URL(base);
testUrl.pathname = `/${databaseName}`;
const migrationsDir = path.resolve(process.cwd(), "db/migrations");
const admin = new Client({ connectionString: adminUrl.toString() });
let adminConnected = false;
let client;

async function applyMigration(filename) {
  const sql = await readFile(path.join(migrationsDir, filename), "utf8");
  await client.query(sql);
}

async function dropTemporaryDatabase() {
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()`,
    [databaseName],
  );
  await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
}

try {
  await admin.connect();
  adminConnected = true;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  client = new Client({ connectionString: testUrl.toString() });
  await client.connect();

  const migrations = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  const migration0026Index = migrations.indexOf("0026_node6_2_recovery_execution.sql");
  if (migration0026Index < 0) throw new Error("0026_node6_2_recovery_execution.sql is missing");

  for (const filename of migrations.slice(0, migration0026Index)) {
    await applyMigration(filename);
  }

  const sourceResult = await client.query(
    `SELECT id FROM source_definitions WHERE source_key='RIPE_RIS_BGP'`,
  );
  const sourceDefinitionId = sourceResult.rows[0]?.id;
  if (!sourceDefinitionId) throw new Error("RIPE_RIS_BGP source definition missing before 0026");

  const bucketStart = "2026-08-15T12:00:00.000Z";
  const bucketEnd = "2026-08-15T12:01:00.000Z";
  const seeded = await client.query(
    `INSERT INTO routing_minute_bucket_revisions(
       source_definition_id,capture_profile_revision_id,bucket_start,bucket_end,
       update_message_count,announcement_prefix_event_count,withdrawal_prefix_event_count,
       announced_prefixes,withdrawn_prefixes,all_prefixes,origin_asns,peer_asns,rrcs,
       coverage_status,data_availability,acquisition_basis,input_segment_count,input_fingerprint,
       revision_number
     ) VALUES (
       $1,NULL,$2,$3,7,3,1,
       '["203.0.113.0/24"]'::jsonb,'["2001:db8::/32"]'::jsonb,
       '["2001:db8::/32","203.0.113.0/24"]'::jsonb,'[64500]'::jsonb,'[64501]'::jsonb,'["rrc00"]'::jsonb,
       'COMPLETE','AVAILABLE','LIVE_STREAM',1,$4,1
     ) RETURNING id`,
    [sourceDefinitionId, bucketStart, bucketEnd, "a".repeat(64)],
  );
  const originalRevisionId = seeded.rows[0]?.id;
  if (!originalRevisionId) throw new Error("Failed to seed populated pre-0026 routing revision");

  await client.query(
    `INSERT INTO routing_minute_bucket_heads(
       source_definition_id,bucket_start,bucket_end,current_revision_id
     ) VALUES ($1,$2,$3,$4)`,
    [sourceDefinitionId, bucketStart, bucketEnd, originalRevisionId],
  );

  for (const filename of migrations.slice(migration0026Index)) {
    await applyMigration(filename);
  }

  const result = await client.query(
    `SELECT
       head.current_revision_id,
       current.revision_number,
       current.supersedes_revision_id,
       current.live_collection_coverage_status,
       current.coverage_status,
       current.acquisition_basis,
       current.update_message_count,
       original.live_collection_coverage_status AS original_live_status,
       original.update_message_count AS original_update_message_count,
       (SELECT count(*)::integer FROM routing_minute_bucket_revisions r
         WHERE r.source_definition_id=head.source_definition_id
           AND r.bucket_start=head.bucket_start) AS revision_count
     FROM routing_minute_bucket_heads head
     JOIN routing_minute_bucket_revisions current ON current.id=head.current_revision_id
     JOIN routing_minute_bucket_revisions original ON original.id=$3
     WHERE head.source_definition_id=$1 AND head.bucket_start=$2`,
    [sourceDefinitionId, bucketStart, originalRevisionId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Upgraded routing head missing");

  const assertions = {
    originalRevisionPreserved: row.original_live_status === null && Number(row.original_update_message_count) === 7,
    headAdvancedToNewRevision: row.current_revision_id !== originalRevisionId,
    appendedRevisionSupersedesOriginal: row.supersedes_revision_id === originalRevisionId,
    appendedRevisionNumberAdvanced: Number(row.revision_number) === 2,
    liveCoverageBackfilledOnNewRevision: row.live_collection_coverage_status === "COMPLETE",
    coverageSemanticsPreserved: row.coverage_status === "COMPLETE" && row.acquisition_basis === "LIVE_STREAM",
    routingFactsPreserved: Number(row.update_message_count) === 7,
    exactlyOneAppend: Number(row.revision_count) === 2,
  };

  let immutableUpdateRejected = false;
  try {
    await client.query(
      `UPDATE routing_minute_bucket_revisions SET update_message_count=8 WHERE id=$1`,
      [originalRevisionId],
    );
  } catch (error) {
    immutableUpdateRejected = error?.code === "P0001";
  }
  assertions.immutableRevisionGuardStillActive = immutableUpdateRejected;

  if (!Object.values(assertions).every(Boolean)) {
    throw new Error(`NODE-6.2 upgrade-path assertions failed: ${JSON.stringify(assertions)}`);
  }

  console.log(JSON.stringify({
    schemaVersion: "NODE6_2_POPULATED_UPGRADE_ACCEPTANCE_V1",
    accepted: true,
    assertions,
  }, null, 2));
} finally {
  if (client) await client.end().catch(() => undefined);
  if (adminConnected) {
    await dropTemporaryDatabase().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

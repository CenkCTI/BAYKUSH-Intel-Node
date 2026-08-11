import process from "node:process";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });

try {
  const expectedTables = [
    "source_definitions",
    "source_schedule_state",
    "collection_runs",
    "collection_work_units",
    "source_checkpoints",
    "raw_source_records",
    "source_health",
    "runtime_heartbeats",
  ];
  for (const table of expectedTables) {
    const result = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
    if (!result.rows[0]?.name) throw new Error(`missing table ${table}`);
  }

  const source = await pool.query(
    "SELECT id, enabled, enabled_by_default FROM source_definitions WHERE source_key = 'TEST_SYNTHETIC'",
  );
  if (source.rowCount !== 1) throw new Error("TEST_SYNTHETIC seed missing");
  if (source.rows[0].enabled || source.rows[0].enabled_by_default) throw new Error("TEST_SYNTHETIC must default disabled");

  const run = await pool.query(
    `INSERT INTO collection_runs(source_definition_id, trigger, purpose, state, idempotency_key)
     VALUES ($1,'TEST','RESYNC','RUNNING',$2) RETURNING id`,
    [source.rows[0].id, `migration-test-${Date.now()}`],
  );
  const work = await pool.query(
    `INSERT INTO collection_work_units(run_id, ordinal, work_key, descriptor, state)
     VALUES ($1,0,'migration-test','{}'::jsonb,'RUNNING') RETURNING id`,
    [run.rows[0].id],
  );
  const params = [
    source.rows[0].id,
    run.rows[0].id,
    work.rows[0].id,
    "synthetic:migration-test",
    "a".repeat(64),
    JSON.stringify({ hello: "world" }),
    "node-1-test-v1",
  ];
  await pool.query(
    `INSERT INTO raw_source_records(
       source_definition_id, collection_run_id, collection_work_unit_id,
       source_record_id, payload_sha256, payload, adapter_version
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT DO NOTHING`,
    params,
  );
  await pool.query(
    `INSERT INTO raw_source_records(
       source_definition_id, collection_run_id, collection_work_unit_id,
       source_record_id, payload_sha256, payload, adapter_version
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT DO NOTHING`,
    params,
  );
  const duplicateCount = await pool.query(
    "SELECT count(*)::int AS count FROM raw_source_records WHERE source_record_id = 'synthetic:migration-test'",
  );
  if (duplicateCount.rows[0].count !== 1) throw new Error("raw idempotency constraint failed");

  let immutable = false;
  try {
    await pool.query(
      "UPDATE raw_source_records SET payload = '{}'::jsonb WHERE source_record_id = 'synthetic:migration-test'",
    );
  } catch (error) {
    immutable = String(error).includes("immutable");
  }
  if (!immutable) throw new Error("raw record update immutability failed");

  console.log("NODE-1 migration acceptance passed");
} finally {
  await pool.end();
}

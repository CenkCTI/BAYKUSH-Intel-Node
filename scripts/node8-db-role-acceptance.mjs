import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const admin = new Pool({ connectionString, max: 2 });
const capabilities = ["api", "ingest", "projection", "stream", "recovery"];
const password = "node8c-acceptance-login-password";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectAllowed(pool, sql, label) {
  await pool.query(sql);
  return label;
}

let denialSavepoint = 0;
async function expectDenied(pool, sql, label) {
  const savepoint = `node8c_denial_${denialSavepoint++}`;
  await pool.query(`SAVEPOINT ${savepoint}`);
  try {
    await pool.query(sql);
  } catch (error) {
    await pool.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    if (error?.code === "42501" || error?.code === "25006") return label;
    throw new Error(`${label} failed for an unexpected reason (${error?.code ?? "unknown"}): ${error?.message}`, { cause: error });
  }
  await pool.query(`RELEASE SAVEPOINT ${savepoint}`);
  throw new Error(`${label} unexpectedly succeeded`);
}

async function loginPool(role) {
  const url = new URL(connectionString);
  url.username = `baykush_${role}_acceptance`;
  url.password = password;
  return new Pool({ connectionString: url.toString(), max: 1 });
}

async function provisionAcceptanceLogins() {
  for (const role of capabilities) {
    const login = `baykush_${role}_acceptance`;
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${login}') THEN CREATE ROLE ${login} LOGIN PASSWORD '${password}'; END IF; END $$`);
    await admin.query(`ALTER ROLE ${login} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT PASSWORD '${password}'`);
    const inherited = await admin.query(
      `SELECT parent.rolname FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid=membership.roleid
         JOIN pg_roles member ON member.oid=membership.member
        WHERE member.rolname=$1`,
      [login],
    );
    for (const membership of inherited.rows) await admin.query(`REVOKE ${membership.rolname} FROM ${login}`);
    await admin.query(`GRANT baykush_${role} TO ${login}`);
    if (role === "api") await admin.query(`ALTER ROLE ${login} SET default_transaction_read_only=on`);
    else await admin.query(`ALTER ROLE ${login} RESET default_transaction_read_only`);
  }
}

async function verifyRoleAttributes() {
  for (const role of capabilities) {
    const capability = `baykush_${role}`;
    const login = `${capability}_acceptance`;
    const result = await admin.query(
      `SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication
         FROM pg_roles WHERE rolname=ANY($1::text[]) ORDER BY rolname`,
      [[capability, login]],
    );
    assert(result.rowCount === 2, `missing capability or login role for ${role}`);
    const capabilityRow = result.rows.find((row) => row.rolname === capability);
    const loginRow = result.rows.find((row) => row.rolname === login);
    assert(capabilityRow?.rolcanlogin === false, `${capability} must be NOLOGIN`);
    assert(loginRow?.rolcanlogin === true, `${login} must be LOGIN`);
    for (const row of result.rows) {
      assert(!row.rolsuper && !row.rolcreatedb && !row.rolcreaterole && !row.rolreplication,
        `${row.rolname} has a prohibited role attribute`);
    }
    const memberships = await admin.query(
      `SELECT parent.rolname FROM pg_auth_members membership
         JOIN pg_roles parent ON parent.oid=membership.roleid
         JOIN pg_roles member ON member.oid=membership.member
        WHERE member.rolname=$1 ORDER BY parent.rolname`,
      [login],
    );
    assert(JSON.stringify(memberships.rows.map((row) => row.rolname)) === JSON.stringify([capability]),
      `${login} must inherit only ${capability}`);
  }
}

async function transactional(role, callback) {
  const pool = await loginPool(role);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await callback(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

try {
  await provisionAcceptanceLogins();
  await verifyRoleAttributes();

  await transactional("api", async (pool) => {
    await expectAllowed(pool, "SELECT source_key FROM source_definitions LIMIT 1", "API SELECT");
    await expectDenied(pool, "INSERT INTO runtime_heartbeats(component,instance_id,heartbeat_at) VALUES('API','node8c-test',now())", "API INSERT");
    await expectDenied(pool, "UPDATE source_definitions SET display_name=display_name WHERE false", "API UPDATE");
    await expectDenied(pool, "DELETE FROM raw_source_records WHERE false", "API DELETE");
    await expectDenied(pool, "CREATE TABLE node8c_api_forbidden(id integer)", "API CREATE TABLE");
    await expectDenied(pool, "ALTER TABLE source_definitions ADD COLUMN node8c_forbidden integer", "API ALTER TABLE");
    await expectDenied(pool, "DROP TABLE source_definitions", "API DROP TABLE");
    await expectDenied(pool, "INSERT INTO node_schema_migrations(filename,sha256) VALUES('forbidden',repeat('0',64))", "API migration write");
  });

  await transactional("ingest", async (pool) => {
    await expectAllowed(pool, "INSERT INTO runtime_heartbeats(component,instance_id,heartbeat_at) VALUES('WORKER','node8c-ingest',now())", "ingest heartbeat INSERT");
    await expectAllowed(pool, "UPDATE raw_source_records SET payload=payload WHERE false", "ingest raw UPDATE surface");
    await expectAllowed(pool, "UPDATE historical_backfill_segments SET updated_at=updated_at WHERE false", "ingest backfill UPDATE surface");
    await expectDenied(pool, "UPDATE measurement_bucket_heads SET updated_at=updated_at WHERE false", "ingest projection write");
    await expectDenied(pool, "CREATE TABLE node8c_ingest_forbidden(id integer)", "ingest DDL");
  });

  await transactional("projection", async (pool) => {
    await expectAllowed(pool, "INSERT INTO runtime_heartbeats(component,instance_id,heartbeat_at) VALUES('MEASUREMENT','node8c-projection',now())", "projection heartbeat INSERT");
    await expectAllowed(pool, "UPDATE entity_observation_heads SET updated_at=updated_at WHERE false", "projection entity UPDATE surface");
    await expectAllowed(pool, "DELETE FROM measurement_dirty_buckets WHERE false", "projection dirty-work DELETE");
    await expectAllowed(pool, "UPDATE routing_minute_bucket_heads SET updated_at=updated_at WHERE false", "projection routing UPDATE surface");
    await expectDenied(pool, "UPDATE raw_source_records SET payload=payload WHERE false", "projection raw write");
    await expectDenied(pool, "CREATE TABLE node8c_projection_forbidden(id integer)", "projection DDL");
  });

  await transactional("stream", async (pool) => {
    await expectAllowed(pool, "INSERT INTO runtime_heartbeats(component,instance_id,heartbeat_at) VALUES('STREAM_WORKER','node8c-stream',now())", "stream heartbeat INSERT");
    await expectAllowed(pool, "UPDATE stream_sessions SET updated_at=updated_at WHERE false", "stream session UPDATE surface");
    await expectAllowed(pool, "DELETE FROM stream_segment_payloads WHERE false", "stream retention DELETE");
    await expectDenied(pool, "UPDATE routing_recovery_minute_heads SET updated_at=updated_at WHERE false", "stream recovery write");
    await expectDenied(pool, "CREATE TABLE node8c_stream_forbidden(id integer)", "stream DDL");
  });

  await transactional("recovery", async (pool) => {
    await expectAllowed(pool, "INSERT INTO runtime_heartbeats(component,instance_id,heartbeat_at) VALUES('RECOVERY_WORKER','node8c-recovery',now())", "recovery heartbeat INSERT");
    await expectAllowed(pool, "UPDATE stream_recovery_requests SET updated_at=updated_at WHERE false", "recovery request UPDATE surface");
    await expectAllowed(pool, "UPDATE routing_recovery_minute_heads SET updated_at=updated_at WHERE false", "recovery routing UPDATE surface");
    await expectDenied(pool, "DELETE FROM stream_segment_payloads WHERE false", "recovery stream retention DELETE");
    await expectDenied(pool, "UPDATE raw_source_records SET payload=payload WHERE false", "recovery raw write");
    await expectDenied(pool, "CREATE TABLE node8c_recovery_forbidden(id integer)", "recovery DDL");
  });

  await admin.query("CREATE TABLE node8c_migrator_acceptance(id integer)");
  await admin.query("DROP TABLE node8c_migrator_acceptance");

  console.log(JSON.stringify({
    schemaVersion: "NODE8C_DATABASE_ROLE_ACCEPTANCE_V2",
    accepted: true,
    effectiveLoginTests: true,
    capabilityRoles: capabilities.map((role) => `baykush_${role}`),
    apiDenied: ["INSERT", "UPDATE", "DELETE", "CREATE TABLE", "ALTER TABLE", "DROP TABLE", "migration write"],
    runtimePlanesTested: ["ingest", "projection", "stream", "recovery"],
    migratorDdlSucceeded: true,
  }, null, 2));
} finally {
  await admin.end();
}

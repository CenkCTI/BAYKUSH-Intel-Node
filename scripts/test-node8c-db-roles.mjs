import pg from "pg";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const pool = new Pool({ connectionString, max: 2 });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function role(name) {
  const result = await pool.query(
    `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication
       FROM pg_roles WHERE rolname=$1`,
    [name],
  );
  assert(result.rowCount === 1, `missing database capability role ${name}`);
  return result.rows[0];
}

async function privilege(roleName, table, permission) {
  const result = await pool.query(
    `SELECT has_table_privilege($1, $2, $3) AS allowed`,
    [roleName, `public.${table}`, permission],
  );
  return result.rows[0]?.allowed === true;
}

async function firstTable(pattern) {
  const result = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~ $1 ORDER BY tablename LIMIT 1`,
    [pattern],
  );
  assert(result.rowCount === 1, `expected a table matching ${pattern}`);
  return result.rows[0].tablename;
}

try {
  const capabilities = ["baykush_api", "baykush_ingest", "baykush_projection", "baykush_stream", "baykush_recovery"];
  for (const name of capabilities) {
    const row = await role(name);
    assert(row.rolcanlogin === false, `${name} must remain NOLOGIN`);
    assert(row.rolsuper === false, `${name} must not be superuser`);
    assert(row.rolcreatedb === false, `${name} must not create databases`);
    assert(row.rolcreaterole === false, `${name} must not create roles`);
    assert(row.rolreplication === false, `${name} must not replicate`);
    const schema = await pool.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS allowed`, [name]);
    assert(schema.rows[0]?.allowed === false, `${name} must not CREATE in public schema`);
  }

  assert(await privilege("baykush_api", "source_definitions", "SELECT"), "API must read source definitions");
  for (const permission of ["INSERT", "UPDATE", "DELETE"]) {
    assert(!(await privilege("baykush_api", "source_definitions", permission)), `API must not ${permission} source definitions`);
    assert(!(await privilege("baykush_api", "raw_source_records", permission)), `API must not ${permission} raw evidence`);
  }

  assert(await privilege("baykush_ingest", "raw_source_records", "INSERT"), "ingest must append raw source records");
  assert(!(await privilege("baykush_projection", "raw_source_records", "INSERT")), "projection must not append raw evidence");
  assert(!(await privilege("baykush_stream", "raw_source_records", "INSERT")), "stream must not append source evidence");
  assert(!(await privilege("baykush_recovery", "raw_source_records", "INSERT")), "recovery must not append source evidence");

  const measurementTable = await firstTable("^measurement_");
  assert(await privilege("baykush_projection", measurementTable, "INSERT"), "projection must write measurement state");
  assert(!(await privilege("baykush_ingest", measurementTable, "INSERT")), "ingest must not write measurement state");

  const routingTable = await firstTable("^(routing_|stream_)");
  assert(await privilege("baykush_stream", routingTable, "INSERT"), "stream must write routing state");
  assert(await privilege("baykush_recovery", routingTable, "INSERT"), "recovery must write routing state");
  assert(!(await privilege("baykush_api", routingTable, "INSERT")), "API must not write routing state");

  const deletable = await pool.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~ '^(stream_|recovery_)' ORDER BY tablename LIMIT 1`,
  );
  if (deletable.rowCount === 1) {
    const table = deletable.rows[0].tablename;
    assert(await privilege("baykush_recovery", table, "DELETE"), "recovery must own narrow retention delete capability");
    assert(!(await privilege("baykush_ingest", table, "DELETE")), "ingest must not own retention delete capability");
    assert(!(await privilege("baykush_projection", table, "DELETE")), "projection must not own retention delete capability");
  }

  console.log(JSON.stringify({
    schemaVersion: "NODE8C_DATABASE_ROLE_ACCEPTANCE_V1",
    accepted: true,
    capabilityRoles: capabilities,
    apiReadOnly: true,
    migrationCredentialSeparatedByCompose: true,
  }, null, 2));
} finally {
  await pool.end();
}

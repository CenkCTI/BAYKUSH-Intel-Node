import fs from "node:fs";

const path = process.argv[2] ?? "/tmp/node8-compose.json";
const config = JSON.parse(fs.readFileSync(path, "utf8"));
const expected = [
  "caddy", "postgres", "migrate", "api", "scheduler", "worker", "backfill",
  "normalizer", "measurement", "discovery", "stream-worker", "recovery-worker",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const service of expected) assert(config.services?.[service], `missing production service ${service}`);
assert(config.networks?.backend?.internal === true, "backend network must be internal");
assert(!(config.services.postgres.ports?.length), "PostgreSQL must not publish a host port");
assert(!(config.services.api.ports?.length), "API must not publish a host port");

const published = (config.services.caddy.ports ?? []).map((p) => Number(p.published)).sort((a, b) => a - b);
assert(published.includes(80) && published.includes(443), `Caddy must publish 80/443: ${published}`);
const publicServices = Object.entries(config.services)
  .filter(([, service]) => (service.ports ?? []).length > 0)
  .map(([name]) => name);
assert(publicServices.length === 1 && publicServices[0] === "caddy", `only Caddy may publish host ports: ${publicServices}`);
assert((config.services.api.networks ?? {}).edge !== undefined, "API must join edge network");
assert((config.services.postgres.networks ?? {}).edge === undefined, "PostgreSQL must not join edge network");

for (const [name, service] of Object.entries(config.services)) {
  const env = service.environment ?? {};
  assert(env.DATABASE_URL === undefined, `${name} must not receive raw DATABASE_URL`);
  assert(env.BAYKUSH_NODE_API_TOKEN === undefined, `${name} must not receive raw bearer token`);
}

const expectedDbFiles = {
  migrate: "/run/secrets/baykush/db_migrator_url",
  api: "/run/secrets/baykush/db_api_url",
  scheduler: "/run/secrets/baykush/db_ingest_url",
  worker: "/run/secrets/baykush/db_ingest_url",
  backfill: "/run/secrets/baykush/db_ingest_url",
  normalizer: "/run/secrets/baykush/db_ingest_url",
  measurement: "/run/secrets/baykush/db_projection_url",
  discovery: "/run/secrets/baykush/db_projection_url",
  "stream-worker": "/run/secrets/baykush/db_stream_url",
  "recovery-worker": "/run/secrets/baykush/db_recovery_url",
};
for (const [service, expectedFile] of Object.entries(expectedDbFiles)) {
  assert(config.services[service].environment?.DATABASE_URL_FILE === expectedFile, `${service} database role secret mismatch`);
}
assert(config.services.api.environment?.BAYKUSH_NODE_API_CREDENTIALS_FILE === "/run/secrets/baykush/api_credentials.json", "API credential registry file contract missing");
assert(config.services.postgres.environment?.POSTGRES_PASSWORD === undefined, "PostgreSQL raw password must not be present");
assert(config.services.postgres.environment?.POSTGRES_PASSWORD_FILE === "/run/secrets/baykush/postgres_password", "PostgreSQL password file missing");

const workerEnv = config.services.worker.environment ?? {};
assert(workerEnv.NVD_API_KEY === undefined && workerEnv.THREATFOX_AUTH_KEY === undefined && workerEnv.MALWAREBAZAAR_AUTH_KEY === undefined,
  "provider credentials must be file-backed in production Compose");

const runtimeDbFiles = new Set(Object.entries(expectedDbFiles).filter(([name]) => name !== "migrate").map(([, value]) => value));
assert(runtimeDbFiles.size === 5, "runtime database capability planes must remain distinct");
assert(![...runtimeDbFiles].includes(expectedDbFiles.migrate), "runtime services must never receive migration database credential");

const nodeServices = ["migrate", "api", "scheduler", "worker", "backfill", "normalizer", "measurement", "discovery", "stream-worker", "recovery-worker"];
for (const name of nodeServices) {
  const service = config.services[name];
  assert(service.init === true, `${name} must use an init process`);
  assert(service.read_only === true, `${name} root filesystem must be read-only`);
  assert((service.security_opt ?? []).some((value) => String(value).startsWith("no-new-privileges")), `${name} must set no-new-privileges`);
  assert((service.cap_drop ?? []).map(String).includes("ALL"), `${name} must drop all Linux capabilities`);
  assert(Number(service.pids_limit) > 0, `${name} must have a PID limit`);
  assert(service.mem_limit !== undefined, `${name} must have a memory limit`);
  assert(Number(service.cpus) > 0, `${name} must have a CPU limit`);
  assert((service.tmpfs ?? []).some((value) => String(value).startsWith("/tmp")), `${name} must use bounded tmpfs for /tmp`);
}

const caddy = config.services.caddy;
assert(caddy.read_only === true, "Caddy root filesystem must be read-only");
assert((caddy.cap_drop ?? []).map(String).includes("ALL"), "Caddy must drop default capabilities");
assert((caddy.cap_add ?? []).map(String).includes("NET_BIND_SERVICE"), "Caddy may regain only NET_BIND_SERVICE for low ports");
assert(Number(caddy.pids_limit) > 0 && caddy.mem_limit !== undefined && Number(caddy.cpus) > 0, "Caddy must be resource bounded");

const postgres = config.services.postgres;
assert(Number(postgres.pids_limit) > 0 && postgres.mem_limit !== undefined && Number(postgres.cpus) > 0, "PostgreSQL must be resource bounded");

console.log(JSON.stringify({
  schemaVersion: "NODE8_PRODUCTION_COMPOSE_ACCEPTANCE_V3",
  accepted: true,
  publicServices,
  roleSeparatedDatabaseCredentials: true,
  hardenedNodeRuntime: true,
  boundedInfrastructureServices: true,
}, null, 2));

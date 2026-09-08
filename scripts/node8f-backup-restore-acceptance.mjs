import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const work = mkdtempSync(join(tmpdir(), "node8f-acceptance-"));
const container = `node8f-pg-${process.pid}`;
const secret = `node8f-restic-secret-${process.pid}`;
const evidenceDir = join(work, "evidence");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? root, encoding: "utf8", env: options.env ?? process.env, input: options.input });
  if (result.status !== 0 && !options.expectFailure) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}${result.stderr}`);
  }
  if (options.expectFailure && result.status === 0) throw new Error(`${command} unexpectedly succeeded`);
  return result;
}

function docker(...args) { return run("docker", args); }
function restic(args, cwd = root) {
  return run(join(work, "restic"), args, { cwd, env: testEnv });
}

const runtimeEnv = join(work, "runtime.env");
const passwordFile = join(work, "restic-password");
const repository = join(work, "repository");
const staging = join(work, "staging");
writeFileSync(runtimeEnv, "POSTGRES_USER=baykush\nPOSTGRES_DB=baykush\n", { mode: 0o600 });
writeFileSync(passwordFile, `${secret}\n`, { mode: 0o600 });
const testEnv = {
  ...process.env,
  PATH: `${work}:${process.env.PATH}`,
  ENV_FILE: runtimeEnv,
  COMPOSE_FILE: join(root, "deploy/production/compose.yml"),
  BACKUP_ENV_FILE: join(work, "absent-backup.env"),
  RESTIC_REPOSITORY: repository,
  RESTIC_PASSWORD_FILE: passwordFile,
  POSTGRES_USER: "baykush",
  POSTGRES_DB: "baykush",
  BACKUP_ALLOW_LOCAL_REPOSITORY: "true",
  NODE8_ISOLATED_TEST_MODE: "true",
  NODE8_TEST_DATABASE_CONTAINER: container,
  BACKUP_STAGING_ROOT: staging,
  BACKUP_LOCK_FILE: join(work, "backup.lock"),
  BACKUP_RUN_PRUNE: "true",
  RESTORE_DATABASE: "baykush_restore_acceptance",
  RESTORE_EVIDENCE_DIR: evidenceDir,
  NODE8_RESTORE_CONFIRM: "YES",
};

function snapshotId() {
  const snapshots = JSON.parse(restic(["snapshots", "--tag", "baykush-node", "--json"]).stdout);
  return snapshots.at(-1).short_id;
}

function materialize(snapshot, destination) {
  restic(["restore", snapshot, "--target", destination]);
  const locate = (name) => {
    const pending = [destination];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.name === name) return path;
      }
    }
    throw new Error(`missing ${name}`);
  };
  return { dump: locate("baykush.dump"), manifest: locate("manifest.json"), migrations: locate("migrations.txt") };
}

function createSnapshotFrom(files, name) {
  const directory = join(work, name);
  rmSync(directory, { recursive: true, force: true });
  writeFileSync(join(work, ".keep"), "");
  // Each adversarial snapshot is built from a fresh flat directory so restore's
  // exact-one-artifact rule is exercised as it is in production.
  const flat = join(work, `${name}-flat`);
  rmSync(flat, { recursive: true, force: true });
  cpSync(files.sourceDir, flat, { recursive: true });
  restic(["backup", ...readdirSync(flat), "--tag", "baykush-node", "--tag", name, "--host", "node8f-test"], flat);
  return snapshotId();
}

try {
  docker("run", "-d", "--name", container, "--tmpfs", "/var/lib/postgresql/data", "-e", "POSTGRES_DB=baykush", "-e", "POSTGRES_USER=baykush", "-e", "POSTGRES_PASSWORD=baykush", "-p", "127.0.0.1::5432", "postgres:16");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const ready = spawnSync("docker", ["exec", container, "pg_isready", "-U", "baykush", "-d", "baykush"]);
    if (ready.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    if (attempt === 29) throw new Error("isolated PostgreSQL did not become ready");
  }
  const port = docker("port", container, "5432/tcp").stdout.trim().split(":").at(-1);
  const dbUrl = `postgres://baykush:baykush@127.0.0.1:${port}/baykush`;
  run("npm", ["run", "db:migrate"], { env: { ...process.env, DATABASE_URL: dbUrl } });
  run("npm", ["run", "test:migration"], { env: { ...process.env, DATABASE_URL: dbUrl } });

  const resticContainer = docker("create", "restic/restic:0.18.1").stdout.trim();
  try { docker("cp", `${resticContainer}:/usr/bin/restic`, join(work, "restic")); }
  finally { docker("rm", resticContainer); }
  chmodSync(join(work, "restic"), 0o700);
  restic(["init"]);

  const backup = run("bash", ["deploy/production/scripts/backup.sh"], { env: testEnv });
  if (backup.stdout.includes(secret) || backup.stderr.includes(secret)) throw new Error("backup output leaked a credential");
  const goodSnapshot = snapshotId();
  const extracted = materialize(goodSnapshot, join(work, "good"));
  const manifest = JSON.parse(readFileSync(extracted.manifest, "utf8"));
  if (manifest.dumpFormat !== "postgresql-custom" || statSync(extracted.dump).size < 1) throw new Error("backup artifact contract failed");
  const manifestText = readFileSync(extracted.manifest, "utf8");
  if (manifestText.includes(secret)) throw new Error("manifest leaked a credential");

  const restore = run("bash", ["deploy/production/scripts/restore.sh"], { env: { ...testEnv, RESTORE_SNAPSHOT: goodSnapshot } });
  if (restore.stdout.includes(secret) || restore.stderr.includes(secret)) throw new Error("restore output leaked a credential");
  const evidenceFiles = readdirSync(evidenceDir);
  if (evidenceFiles.length !== 1) throw new Error("restore evidence was not generated exactly once");
  const evidence = JSON.parse(readFileSync(join(evidenceDir, evidenceFiles[0]), "utf8"));
  if (!evidence.accepted || !evidence.provenanceVerified || !evidence.immutableRevisionGuardsVerified) throw new Error("restore evidence is incomplete");

  for (const statement of [
    "UPDATE raw_source_records SET payload='{}'::jsonb WHERE source_record_id='synthetic:migration-test'",
    "UPDATE canonical_evidence_records SET facts='[]'::jsonb WHERE canonical_key='test:migration'",
  ]) {
    const immutable = run("docker", ["exec", "-i", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "baykush", "-d", "baykush_restore_acceptance", "-c", statement], { expectFailure: true });
    if (!`${immutable.stdout}${immutable.stderr}`.includes("immutable")) throw new Error("restored immutable revision guard did not reject mutation");
  }

  const cases = [
    ["wrong-checksum", ({ manifest: path }) => { const value = JSON.parse(readFileSync(path)); value.dumpSha256 = "0".repeat(64); writeFileSync(path, `${JSON.stringify(value)}\n`); }],
    ["manifest-tamper", ({ manifest: path }) => { const value = JSON.parse(readFileSync(path)); value.includesSecrets = true; writeFileSync(path, `${JSON.stringify(value)}\n`); }],
    ["truncated-dump", ({ dump: path }) => truncateSync(path, 64)],
    ["missing-ledger-metadata", ({ manifest: path }) => { const value = JSON.parse(readFileSync(path)); delete value.migrationCount; writeFileSync(path, `${JSON.stringify(value)}\n`); }],
    ["missing-artifact", ({ dump: path }) => rmSync(path)],
  ];
  for (const [name, mutate] of cases) {
    const restored = join(work, `case-${name}`);
    const files = materialize(goodSnapshot, restored);
    mutate(files);
    const sourceDir = join(files.manifest, "..");
    const snapshot = createSnapshotFrom({ sourceDir }, name);
    const before = existsSync(evidenceDir) ? readdirSync(evidenceDir).length : 0;
    run("bash", ["deploy/production/scripts/restore.sh"], { env: { ...testEnv, RESTORE_SNAPSHOT: snapshot }, expectFailure: true });
    const after = existsSync(evidenceDir) ? readdirSync(evidenceDir).length : 0;
    if (after !== before) throw new Error(`${name} produced accepted restore evidence`);
  }

  process.stdout.write(`${JSON.stringify({
    schemaVersion: "NODE8F_REAL_ACCEPTANCE_V1",
    accepted: true,
    backupSnapshot: goodSnapshot,
    artifactBytes: statSync(extracted.dump).size,
    migrationCount: evidence.migrationCount,
    rawRecordCount: evidence.rawRecordCount,
    canonicalRecordCount: evidence.canonicalRecordCount,
    corruptionCasesRejected: cases.map(([name]) => name),
    retention: { last: 8, daily: 7, weekly: 4, monthly: 6 },
  }, null, 2)}\n`);
} finally {
  spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  rmSync(work, { recursive: true, force: true });
}

import { mkdtempSync, readFileSync, chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(".");
const deployPath = join(root, "deploy/production/scripts/deploy.sh");
const rollbackPath = join(root, "deploy/production/scripts/rollback.sh");
const selectorPath = join(root, "deploy/production/scripts/set-release-image.sh");
const deploy = readFileSync(deployPath, "utf8");
const rollback = readFileSync(rollbackPath, "utf8");
const evidence = readFileSync("deploy/production/scripts/release-evidence.sh", "utf8");
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => children.splice(0).forEach((child) => child.kill("SIGKILL")));

const digest = (char: string) => `ghcr.io/cenkcti/baykush-intel-node@sha256:${char.repeat(64)}`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "node8h-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "events.log");
  writeFileSync(log, "");
  const envFile = join(dir, "runtime.env");
  const lock = join(dir, "deploy.lock");
  const releaseDir = join(dir, "releases");
  const gateDir = join(dir, "gates");
  mkdirSync(releaseDir);
  writeFileSync(envFile, `BAYKUSH_NODE_IMAGE=${digest("a")}\nPOSTGRES_USER=baykush\nPOSTGRES_DB=baykush\n`, { mode: 0o600 });
  writeFileSync(join(dir, "compose.yml"), "name: fixture\nservices: {}\nvolumes: {baykush_pgdata: {}}\n");
  const executable = (name: string, body: string) => {
    const path = join(name === "docker" ? bin : dir, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  executable("docker", `
printf 'docker %s\\n' "$*" >> "${log}"
case "$*" in
  *" ps -q postgres"*) [[ \${DB_RUNNING:-false} == true ]] && printf 'postgres-id\\n';;
  *"exec -T postgres psql"*)
    if [[ "$*" == *"to_regclass"* ]]; then [[ \${DURABLE_DB:-false} == true ]] && printf 't\\n' || printf 'f\\n'; else printf '001.sql\\t${"1".repeat(64)}\\n'; fi;;
  *"config --format json"*) printf '{"name":"fixture"}\\n';;
  "volume inspect "*) [[ \${DURABLE_VOLUME:-false} == true ]];;
  *"run --rm migrate"*) [[ \${FAIL_GATE:-} != migration ]];;
esac`);
  const simple = (name: string, event: string, fail = "") => executable(name, `printf '${event}\\n' >> "${log}"\n${fail}`);
  const preflight = simple("preflight.sh", "preflight");
  const roles = simple("roles.sh", "roles");
  const smoke = simple("smoke.sh", "smoke", '[[ ${FAIL_GATE:-} != smoke ]]');
  const runtime = simple("runtime.sh", "runtime-audit", '[[ ${FAIL_GATE:-} != runtime ]]');
  const network = simple("network.sh", "network-audit", '[[ ${FAIL_GATE:-} != network ]]');
  const release = executable("release.sh", `printf 'release-evidence\\n' >> "${log}"\ntouch "${dir}/accepted"`);
  const backup = executable("backup.sh", `
printf 'backup\\n' >> "${log}"
[[ \${FAIL_GATE:-} != backup ]]
if [[ -n \${BACKUP_EVIDENCE_OUT:-} && \${BACKUP_EVIDENCE_MODE:-valid} != missing ]]; then
  if [[ \${BACKUP_EVIDENCE_MODE:-valid} == invalid ]]; then printf '{}\\n' > "$BACKUP_EVIDENCE_OUT";
  else printf '{"schemaVersion":"NODE8_BACKUP_GATE_EVIDENCE_V1","durable":true,"createdAt":"2026-09-07T00:00:00Z","snapshotId":"12345678","dumpSha256":"${"2".repeat(64)}","migrationLedgerSha256":"${"3".repeat(64)}"}\\n' > "$BACKUP_EVIDENCE_OUT"; fi
fi`);
  const common = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, NODE8_ISOLATED_TEST_MODE: "true", ENV_FILE: envFile,
    COMPOSE_FILE: join(dir, "compose.yml"), DEPLOY_LOCK_FILE: lock, BACKUP_GATE_DIR: gateDir,
    PREFLIGHT_SCRIPT: preflight, DB_ROLE_SCRIPT: roles, BACKUP_SCRIPT: backup,
    SMOKE_SCRIPT: smoke, RUNTIME_AUDIT_SCRIPT: runtime, NETWORK_AUDIT_SCRIPT: network,
    RELEASE_EVIDENCE_SCRIPT: release, RELEASE_DIR: releaseDir, SET_IMAGE_SCRIPT: selectorPath,
  };
  return { dir, log, envFile, lock, releaseDir, common };
}

function run(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync("bash", [script, ...args], { env, encoding: "utf8" });
}

describe("NODE-8H release transaction", () => {
  it("orders durable backup, migration, roles, smoke, audits, then evidence", () => {
    const f = fixture();
    const result = run(deployPath, { ...f.common, DURABLE_VOLUME: "true" });
    expect(result.status, result.stderr).toBe(0);
    const events = readFileSync(f.log, "utf8");
    const ordering: Array<[string, string]> = [["backup", "run --rm migrate"], ["run --rm migrate", "roles"], ["smoke", "runtime-audit"], ["runtime-audit", "network-audit"], ["network-audit", "release-evidence"]];
    for (const [before, after] of ordering) {
      expect(events.indexOf(before)).toBeLessThan(events.indexOf(after));
    }
  });

  it.each(["backup", "migration", "smoke", "runtime", "network"])("fails closed at the %s gate without accepted evidence", (gate) => {
    const f = fixture();
    const result = run(deployPath, { ...f.common, DURABLE_VOLUME: "true", FAIL_GATE: gate });
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(join(f.dir, "accepted"))).toThrow();
  });

  it.each(["missing", "invalid"])("rejects %s backup durability evidence", (mode) => {
    const f = fixture();
    const result = run(deployPath, { ...f.common, DURABLE_VOLUME: "true", BACKUP_EVIDENCE_MODE: mode });
    expect(result.status).not.toBe(0);
    expect(readFileSync(f.log, "utf8")).not.toContain("run --rm migrate");
  });

  it.each(["", "repo:latest", "repo@sha256:nope", `@sha256:${"a".repeat(64)}`])("rejects mutable or malformed image %j before mutation", (image) => {
    const f = fixture();
    writeFileSync(f.envFile, `BAYKUSH_NODE_IMAGE=${image}\nPOSTGRES_USER=baykush\n`, { mode: 0o600 });
    const result = run(deployPath, f.common);
    expect(result.status).not.toBe(0);
    expect(readFileSync(f.log, "utf8")).not.toContain("docker");
  });

  it("uses one lock for deploy and rollback and fails before mutation", async () => {
    const f = fixture();
    writeFileSync(join(f.releaseDir, "current.json"), JSON.stringify({
      schemaVersion: "NODE8_RELEASE_EVIDENCE_V1", result: "ACCEPTED", accepted: true,
      image: digest("a"), previousImage: digest("b"), migrationLedgerSha256: "1".repeat(64),
      productionComposeSha256: "2".repeat(64), smokeAccepted: true,
      runtimeAuditAccepted: true, networkAuditAccepted: true,
    }));
    const holder = spawn("flock", [f.lock, "sleep", "10"]); children.push(holder);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(run(deployPath, f.common).status).not.toBe(0);
    const rollbackResult = run(rollbackPath, { ...f.common, NODE8_ROLLBACK_CONFIRM: "YES", NODE8_ROLLBACK_SCHEMA_COMPATIBLE: "YES" });
    expect(rollbackResult.status).not.toBe(0);
    expect(readFileSync(f.log, "utf8")).toBe("");
  });
});

describe("NODE-8H rollback and evidence contract", () => {
  it("requires explicit application and schema confirmations", () => {
    const f = fixture();
    expect(run(rollbackPath, f.common).stderr).toContain("NODE8_ROLLBACK_CONFIRM");
    expect(run(rollbackPath, { ...f.common, NODE8_ROLLBACK_CONFIRM: "YES" }).stderr).toContain("NODE8_ROLLBACK_SCHEMA_COMPATIBLE");
  });

  it("keeps migrations forward-only and binds rollback to accepted evidence", () => {
    expect(rollback).toContain("migration ledger is incompatible");
    expect(rollback).toContain("database schema is NOT rolled back");
    expect(rollback).not.toMatch(/down[- ]migrat/i);
    expect(evidence).toContain("NODE8_RELEASE_EVIDENCE_V1");
    expect(evidence).toContain("result: 'ACCEPTED'");
    expect(evidence).not.toMatch(/password|bearer|credential|databaseUrl/i);
    expect(deploy.indexOf('bash "$SMOKE_SCRIPT"')).toBeLessThan(deploy.indexOf('bash "$RELEASE_EVIDENCE_SCRIPT"'));
  });

  it.each([
    ["missing previous image", null, "no previous digest-pinned release"],
    ["malformed previous image", "repo:latest", "no previous digest-pinned release"],
    ["unaccepted evidence", digest("b"), "invalid or tampered"],
  ])("rejects %s", (_name, previousImage, error) => {
    const f = fixture();
    writeFileSync(join(f.releaseDir, "current.json"), JSON.stringify({
      schemaVersion: "NODE8_RELEASE_EVIDENCE_V1", result: _name === "unaccepted evidence" ? "FAILED" : "ACCEPTED", accepted: true,
      image: digest("a"), previousImage, migrationLedgerSha256: "1".repeat(64), productionComposeSha256: "2".repeat(64),
      smokeAccepted: true, runtimeAuditAccepted: true, networkAuditAccepted: true,
    }));
    const result = run(rollbackPath, { ...f.common, NODE8_ROLLBACK_CONFIRM: "YES", NODE8_ROLLBACK_SCHEMA_COMPATIBLE: "YES" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(readFileSync(f.log, "utf8")).not.toContain("backup");
  });

  it("rejects migration ledger incompatibility before backup or image mutation", () => {
    const f = fixture();
    writeFileSync(join(f.releaseDir, "current.json"), JSON.stringify({
      schemaVersion: "NODE8_RELEASE_EVIDENCE_V1", result: "ACCEPTED", accepted: true,
      image: digest("a"), previousImage: digest("b"), migrationLedgerSha256: "0".repeat(64), productionComposeSha256: "2".repeat(64),
      smokeAccepted: true, runtimeAuditAccepted: true, networkAuditAccepted: true,
    }));
    const result = run(rollbackPath, { ...f.common, NODE8_ROLLBACK_CONFIRM: "YES", NODE8_ROLLBACK_SCHEMA_COMPATIBLE: "YES" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("migration ledger is incompatible");
    expect(readFileSync(f.log, "utf8")).not.toContain("backup");
  });

  it("updates the release image atomically only after digest validation", () => {
    const f = fixture();
    const original = readFileSync(f.envFile, "utf8");
    expect(run(selectorPath, f.common, ["repo:latest"]).status).not.toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toBe(original);
    expect(run(selectorPath, f.common, [digest("b")]).status).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toContain(`BAYKUSH_NODE_IMAGE=${digest("b")}`);
  });

  it("performs an application-only rollback after ledger compatibility and all gates", () => {
    const f = fixture();
    const ledger = `001.sql\t${"1".repeat(64)}\n`;
    const ledgerSha = createHash("sha256").update(ledger).digest("hex");
    writeFileSync(join(f.releaseDir, "current.json"), JSON.stringify({
      schemaVersion: "NODE8_RELEASE_EVIDENCE_V1", result: "ACCEPTED", accepted: true,
      image: digest("a"), previousImage: digest("b"), migrationLedgerSha256: ledgerSha, productionComposeSha256: "2".repeat(64),
      smokeAccepted: true, runtimeAuditAccepted: true, networkAuditAccepted: true,
    }));
    const result = run(rollbackPath, { ...f.common, NODE8_ROLLBACK_CONFIRM: "YES", NODE8_ROLLBACK_SCHEMA_COMPATIBLE: "YES" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(f.envFile, "utf8")).toContain(`BAYKUSH_NODE_IMAGE=${digest("b")}`);
    const events = readFileSync(f.log, "utf8");
    expect(events.indexOf("backup")).toBeLessThan(events.indexOf(" pull"));
    expect(events.indexOf("network-audit")).toBeLessThan(events.indexOf("release-evidence"));
  });

  it("generates allow-listed accepted evidence without sourced secrets", () => {
    const f = fixture();
    writeFileSync(f.envFile, readFileSync(f.envFile, "utf8") + "API_BEARER_TOKEN=do-not-leak\nDATABASE_URL=postgres://secret:password@db/x\n");
    const result = run(join(root, "deploy/production/scripts/release-evidence.sh"), {
      ...f.common, RELEASE_DIR: f.releaseDir, BACKUP_GATE_PASSED: "true",
    });
    expect(result.status, result.stderr).toBe(0);
    const generated = readFileSync(join(f.releaseDir, "current.json"), "utf8");
    const parsed = JSON.parse(generated);
    expect(parsed).toMatchObject({ schemaVersion: "NODE8_RELEASE_EVIDENCE_V1", result: "ACCEPTED", accepted: true, image: digest("a") });
    expect(generated).not.toMatch(/do-not-leak|secret:password|bearer|credential|databaseUrl/i);
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiCredential } from "../src/api/auth.js";
import { InMemoryApiRateLimiter } from "../src/api/rate-limit.js";
import { apiHeartbeatMode, sourceOperationalState, type SourceHealthRow } from "../src/api/ops-api.js";
import type { createApiServer as CreateApiServer } from "../src/api/server.js";

const OPS_TOKEN = "node8-operations-token-that-is-at-least-32-bytes";
const CITEM_TOKEN = "node8-citem-token-that-is-at-least-32-bytes";
const servers: Server[] = [];
const tempDirs: string[] = [];
const now = new Date("2026-09-07T12:00:00.000Z");
const mocks = vi.hoisted(() => ({ heartbeatRows: [] as Array<Record<string, unknown>> }));

vi.mock("../src/db/pool.js", () => ({
  pool: { query: vi.fn(async (sql: string) => {
    if (sql.includes("SELECT now()")) return { rows: [{ now }], rowCount: 1 };
    if (sql.includes("node_runtime_component_health")) return { rows: mocks.heartbeatRows, rowCount: mocks.heartbeatRows.length };
    if (sql.includes("FROM source_definitions")) return { rows: [
      { source_key: "HEALTHY", health_status: "HEALTHY", last_attempt_at: now, last_success_at: now, last_failure_at: null, consecutive_failures: 0, latest_failure_code: null, updated_at: now, default_poll_interval_seconds: 60, coverage_status: "COMPLETE", coverage_evaluated_through: now },
      { source_key: "FAILED", health_status: "FAILED", last_attempt_at: now, last_success_at: new Date(now.getTime() - 60_000), last_failure_at: now, consecutive_failures: 1, latest_failure_code: "PROVIDER_ERROR", updated_at: now, default_poll_interval_seconds: 60, coverage_status: "PARTIAL", coverage_evaluated_through: now },
      { source_key: "NEVER", health_status: null, last_attempt_at: null, last_success_at: null, last_failure_at: null, consecutive_failures: null, latest_failure_code: null, updated_at: null, default_poll_interval_seconds: 60, coverage_status: null, coverage_evaluated_through: null },
      { source_key: "STALE", health_status: "HEALTHY", last_attempt_at: new Date(now.getTime() - 300_000), last_success_at: new Date(now.getTime() - 300_000), last_failure_at: null, consecutive_failures: 0, latest_failure_code: null, updated_at: now, default_poll_interval_seconds: 60, coverage_status: "NO_COVERAGE", coverage_evaluated_through: now },
    ], rowCount: 4 };
    throw new Error(`unexpected query: ${sql}`);
  }), end: vi.fn() },
}));

let createApiServer: typeof CreateApiServer;
beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
  ({ createApiServer } = await import("../src/api/server.js"));
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  mocks.heartbeatRows = [];
});

async function startServer(rateLimiter?: InMemoryApiRateLimiter) {
  const credentials: ApiCredential[] = [
    { id: "citem", token: CITEM_TOKEN, scopes: ["techint:read", "sources:read"] },
    { id: "operations", token: OPS_TOKEN, scopes: ["ops:read"] },
  ];
  const server = rateLimiter
    ? createApiServer({ apiCredentials: credentials, rateLimiter })
    : createApiServer({ apiCredentials: credentials });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function opsRequest(base: string, token?: string) {
  return fetch(`${base}/v1/ops/health`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
}

interface OpsBody {
  data: {
    runtimeComponents: Array<Record<string, unknown>>;
    sources: { statusCounts: Record<string, number>; items: Array<Record<string, unknown>> };
    semantics: Record<string, string>;
  };
}

describe("NODE-8G operations API", () => {
  it("enforces a separate ops scope and bounded rate limiting without credential leakage", async () => {
    const base = await startServer(new InMemoryApiRateLimiter({ windowMs: 60_000, standardLimit: 1, expensiveLimit: 1 }));
    expect((await opsRequest(base)).status).toBe(401);
    const invalid = await opsRequest(base, "invalid-credential");
    expect(invalid.status).toBe(401);
    expect(await invalid.text()).not.toContain("invalid-credential");
    expect((await opsRequest(base, CITEM_TOKEN)).status).toBe(403);
    expect((await opsRequest(base, OPS_TOKEN)).status).toBe(200);
    expect((await opsRequest(base, OPS_TOKEN)).status).toBe(429);
  });

  it("reports fresh, stale, missing and later/restarted heartbeat evidence without metadata", async () => {
    mocks.heartbeatRows = [
      { component: "WORKER", instance_id: "worker-1", heartbeat_at: now, heartbeat_age_seconds: "0", fresh: true },
      { component: "SCHEDULER", instance_id: "scheduler-1", heartbeat_at: new Date(now.getTime() - 61_000), heartbeat_age_seconds: "61", fresh: false },
    ];
    const base = await startServer();
    const first = await (await opsRequest(base, OPS_TOKEN)).json() as OpsBody;
    expect(first.data.runtimeComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "WORKER", status: "FRESH" }),
      expect.objectContaining({ component: "SCHEDULER", status: "STALE" }),
      expect.objectContaining({ component: "DISCOVERY_WORKER", status: "MISSING", heartbeatAt: null }),
    ]));
    expect(JSON.stringify(first)).not.toContain("metadata");
    mocks.heartbeatRows.push({ component: "DISCOVERY_WORKER", instance_id: "discovery-restarted", heartbeat_at: now, heartbeat_age_seconds: "0", fresh: true });
    const later = await (await opsRequest(base, OPS_TOKEN)).json() as OpsBody;
    expect(later.data.runtimeComponents).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: "DISCOVERY_WORKER", instanceId: "discovery-restarted", status: "FRESH" }),
    ]));
  });

  it("distinguishes healthy, failed, never-run, stale and missing-coverage source states", async () => {
    const body = await (await opsRequest(await startServer(), OPS_TOKEN)).json() as OpsBody;
    expect(body.data.sources.statusCounts).toEqual({ HEALTHY: 1, RECENT_FAILURE: 1, NEVER_RUN: 1, STALE: 1 });
    expect(body.data.sources.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceKey: "FAILED", operationalState: "RECENT_FAILURE", latestCoverage: "PARTIAL" }),
      expect.objectContaining({ sourceKey: "NEVER", operationalState: "NEVER_RUN", latestCoverage: "UNKNOWN" }),
      expect.objectContaining({ sourceKey: "STALE", operationalState: "STALE", latestCoverage: "NO_COVERAGE" }),
    ]));
    expect(body.data.semantics.unknownOrStaleMeans).toContain("not evidence of zero workload, zero incidents or no attacks");
    expect(body.data.semantics.infrastructureHealthDoesNotRepresent).toContain("attacker origin");
  });

  it("defaults production API observation to probe-only mode", () => {
    expect(apiHeartbeatMode({ NODE_ENV: "production" })).toBe("PROBE_ONLY");
    expect(apiHeartbeatMode({ NODE_ENV: "development" })).toBe("DATABASE");
  });

  it("classifies provider failure ahead of an older success", () => {
    expect(sourceOperationalState({ last_attempt_at: now, last_success_at: new Date(now.getTime() - 1_000), last_failure_at: now, default_poll_interval_seconds: 60 } as SourceHealthRow, now)).toBe("RECENT_FAILURE");
  });
});

interface SnapshotEvidence { schemaVersion: string; status: string; containsSecrets: boolean; semantics: string; problems: Array<{ class: string }> }
function snapshotFixture(options: { disk?: number; backupAgeHours?: number | null; containerState?: string; failedCheck?: string } = {}): SnapshotEvidence {
  const directory = mkdtempSync(path.join(os.tmpdir(), "node8-ops-")); tempDirs.push(directory);
  const files = ["containers.json", "containers.status", "disk.txt", "disk.status", "api.json", "api.status", "backups.json", "backups.status", "out.json"];
  const paths = Object.fromEntries(files.map((file) => [file, path.join(directory, file)]));
  writeFileSync(paths["containers.json"]!, JSON.stringify([{ Service: "api", State: options.containerState ?? "running", Health: "healthy" }]));
  writeFileSync(paths["containers.status"]!, options.failedCheck === "containers" ? "failed" : "ok");
  writeFileSync(paths["disk.txt"]!, `/dev/root 100 50 50 ${options.disk ?? 50}% /`);
  writeFileSync(paths["disk.status"]!, options.failedCheck === "disk" ? "failed" : "ok");
  writeFileSync(paths["api.json"]!, JSON.stringify({ data: { status: "ok" } })); writeFileSync(paths["api.status"]!, "ok");
  const backupAge = options.backupAgeHours === undefined ? 1 : options.backupAgeHours;
  writeFileSync(paths["backups.json"]!, backupAge === null ? "[]" : JSON.stringify([{ time: new Date(Date.now() - backupAge * 3_600_000).toISOString() }]));
  writeFileSync(paths["backups.status"]!, options.failedCheck === "backup" ? "failed" : "ok");
  const result = spawnSync(process.execPath, ["deploy/production/scripts/node8-ops-snapshot-evidence.mjs", ...files.slice(0, 8).map((file) => paths[file]!), paths["out.json"]!, "80", "90", "8"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(readFileSync(paths["out.json"]!, "utf8")) as SnapshotEvidence;
}

describe("NODE8_OPS_SNAPSHOT_V1 evidence", () => {
  it("is healthy only when all real checks have healthy evidence", () => expect(snapshotFixture()).toMatchObject({ schemaVersion: "NODE8_OPS_SNAPSHOT_V1", status: "HEALTHY", containsSecrets: false }));
  it("uses deterministic warning and critical disk thresholds", () => {
    expect(snapshotFixture({ disk: 80 }).problems[0]?.class).toBe("DISK_WARNING");
    expect(snapshotFixture({ disk: 90 }).problems[0]?.class).toBe("DISK_CRITICAL");
  });
  it("allows a bounded operator-selected disk path while preserving the production default", () => {
    const script = readFileSync("deploy/production/scripts/ops-snapshot.sh", "utf8");
    expect(script).toContain("DISK_PATH=${DISK_PATH:-/var/lib/docker}");
    expect(script).toContain('df -P "$DISK_PATH"');
  });
  it("reports stale and missing backup evidence without false green", () => {
    expect(snapshotFixture({ backupAgeHours: 9 }).problems[0]?.class).toBe("BACKUP_STALE");
    expect(snapshotFixture({ backupAgeHours: null }).problems[0]?.class).toBe("BACKUP_UNKNOWN");
  });
  it("keeps unavailable disk/container checks unknown instead of healthy", () => {
    expect(snapshotFixture({ failedCheck: "disk" }).problems[0]?.class).toBe("DISK_UNKNOWN");
    expect(snapshotFixture({ failedCheck: "containers" }).problems[0]?.class).toBe("CONTAINERS_UNKNOWN");
  });
  it("labels evidence as operational rather than intelligence severity", () => expect(snapshotFixture().semantics).toContain("not threat level"));
});

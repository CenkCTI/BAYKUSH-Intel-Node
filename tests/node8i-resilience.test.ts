import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { InMemoryApiRateLimiter } from "../src/api/rate-limit.js";
import type { ApiCredential } from "../src/api/auth.js";
import type { createApiServer as CreateApiServer } from "../src/api/server.js";
import { fetchBoundedJson, fetchBoundedSource } from "../src/http/source-http.js";
import { CollectionFailure } from "../src/runtime/failure.js";
import { retryDelaySeconds } from "../src/runtime/retry.js";
import { runLoadAcceptance } from "../scripts/node8-load-acceptance.mjs";

const TOKEN = "node8i-credential-that-is-definitely-32-bytes";
const url = new URL("https://provider.example.test/feed");
const baseRequest = { url, allowedHost: url.hostname, allowedPath: url.pathname, maxBytes: 1024, timeoutMs: 50 };
const durableState = () => ({ checkpoint: { cursor: 7 }, provenance: ["raw-a", "canonical-a"], coverage: "UNKNOWN" });
const servers: Server[] = [];
let createApiServer: typeof CreateApiServer;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
  ({ createApiServer } = await import("../src/api/server.js"));
});
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

async function failureOf(promise: Promise<unknown>) {
  try { await promise; throw new Error("expected failure"); } catch (error) {
    expect(error).toBeInstanceOf(CollectionFailure);
    return error as CollectionFailure;
  }
}

describe("NODE-8I deterministic provider failure acceptance", () => {
  it("classifies DNS failure without checkpoint, provenance, or coverage mutation", async () => {
    const before = durableState(); const after = structuredClone(before);
    const error = await failureOf(fetchBoundedSource({ ...baseRequest, resolveHost: async () => { throw new Error("fixture DNS failure"); } }));
    expect(error).toMatchObject({ code: "TRANSPORT_ERROR", retryable: true });
    expect(after).toEqual(before);
  });

  it.each([[429, "RATE_LIMITED"], [503, "PROVIDER_ERROR"]] as const)("classifies HTTP %i and preserves semantic state", async (status, code) => {
    const before = durableState(); const after = structuredClone(before);
    const error = await failureOf(fetchBoundedSource({ ...baseRequest, fetchImpl: async () => new Response("failure", { status, headers: status === 429 ? { "retry-after": "3" } : {} }) }));
    expect(error).toMatchObject({ code, retryable: true });
    if (status === 429) {
      expect(error.retryAfterSeconds).toBe(3);
      expect(retryDelaySeconds({ attemptCount: 1, baseSeconds: 1, maxSeconds: 60, providerRetryAfterSeconds: error.retryAfterSeconds! })).toBeGreaterThanOrEqual(3);
    }
    expect(after).toEqual(before);
  });

  it("bounds provider timeout without fabricating accepted data", async () => {
    const error = await failureOf(fetchBoundedSource({ ...baseRequest, timeoutMs: 10, fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) }));
    expect(error).toMatchObject({ code: "TIMEOUT", retryable: true });
  });

  it("fails closed on malformed/schema-changed JSON", async () => {
    const error = await failureOf(fetchBoundedJson({ ...baseRequest, fetchImpl: async () => new Response("{changed", { status: 200, headers: { "content-type": "application/json" } }) }));
    expect(error).toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
  });
});

describe("NODE-8I auth and rate-limit failure acceptance", () => {
  async function start(credentials: ApiCredential[], limiter = new InMemoryApiRateLimiter()) {
    const server = createApiServer({ apiCredentials: credentials, rateLimiter: limiter }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const get = (base: string, route: string, token: string) => fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } });
  it("returns controlled 401/403/429 without credentials or state mutation", async () => {
    const state = durableState(); const base = await start([{ id: "limited", token: TOKEN, scopes: ["techint:read"] }], new InMemoryApiRateLimiter({ windowMs: 60_000, standardLimit: 1, expensiveLimit: 1 }));
    for (const [response, status] of [[await get(base, "/v1/sources", "invalid"), 401], [await get(base, "/v1/sources", TOKEN), 403]] as const) {
      expect(response.status).toBe(status); expect(await response.text()).not.toContain(TOKEN);
    }
    expect((await get(base, "/v1/techint/measurement-catalog", TOKEN)).status).toBe(200);
    const limited = await get(base, "/v1/techint/measurement-catalog", TOKEN);
    expect(limited.status).toBe(429); expect(limited.headers.get("retry-after")).toBeTruthy(); expect(await limited.text()).not.toContain(TOKEN);
    expect(state).toEqual(durableState());
  });
});

describe("NODE-8I fault matrix and load negative acceptance", () => {
  it("keeps the service harness confirmation-gated, non-destructive, and fail-closed on recovery", () => {
    const harness = readFileSync("deploy/production/scripts/fault-acceptance.sh", "utf8");
    expect(harness).toContain("NODE8_FAULT_ACCEPTANCE_CONFIRM");
    expect(harness).toContain('append_result "$id" FAIL "service recovery or durable semantic baseline verification failed"');
    expect(harness).toContain('[[ "$failed" == 0 ]] || fail');
    expect(harness).not.toMatch(/down\s+-v|volume\s+rm|DROP\s+(TABLE|SCHEMA)|TRUNCATE/iu);
  });

  it("accepts the authoritative matrix and rejects duplicate, missing, and falsely automated real-host scenarios", () => {
    const valid = JSON.parse(execFileSync("node", ["scripts/validate-node8-fault-matrix.mjs"], { encoding: "utf8" }));
    expect(valid).toMatchObject({ accepted: true, scenarioCount: 20, manualRealHostCount: 6 });
    const directory = mkdtempSync(path.join(os.tmpdir(), "node8i-matrix-"));
    try {
      const original = JSON.parse(readFileSync("deploy/production/acceptance/fault-matrix.json", "utf8"));
      interface MatrixScenario { id: string; executionMode: string; realHostRequired: boolean }
      interface Matrix { scenarios: MatrixScenario[] }
      for (const mutate of [(matrix: Matrix) => matrix.scenarios.push(structuredClone(matrix.scenarios[0]!)), (matrix: Matrix) => { matrix.scenarios = matrix.scenarios.filter((item) => item.id !== "DNS_FAILURE"); }, (matrix: Matrix) => { matrix.scenarios[0]!.executionMode = "AUTOMATED_UNIT"; matrix.scenarios[0]!.realHostRequired = false; }]) {
        const matrix = structuredClone(original); mutate(matrix); const file = path.join(directory, `${Math.random()}.json`); writeFileSync(file, JSON.stringify(matrix));
        const result = spawnSync("node", ["scripts/validate-node8-fault-matrix.mjs", file], { encoding: "utf8" });
        expect(result.status).toBe(1); expect(JSON.parse(result.stdout).accepted).toBe(false);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("reports bounded load success and fails threshold and timeout cases", async () => {
    const config = { baseUrl: "https://node.example.test", token: TOKEN, requests: 4, concurrency: 2, timeoutMs: 100, p95LimitMs: 2000, maxErrorRate: 0.01, endpoints: ["/v1/techint/measurement-catalog"] };
    const accepted = await runLoadAcceptance({ ...config, fetchImpl: async () => new Response("{}", { status: 200 }) });
    expect(accepted).toMatchObject({ schemaVersion: "NODE8_LOAD_ACCEPTANCE_V1", accepted: true, successfulRequests: 4, failedRequests: 0 });
    const threshold = await runLoadAcceptance({ ...config, p95LimitMs: 0.01, fetchImpl: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); return new Response("{}", { status: 200 }); } });
    expect(threshold.accepted).toBe(false);
    const timeout = await runLoadAcceptance({ ...config, fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))) });
    expect(timeout).toMatchObject({ accepted: false, failedRequests: 4, errorCounts: { timeout: 4 } });
  });

  it("rejects a missing load credential file without emitting accepted evidence", () => {
    const result = spawnSync("node", ["scripts/node8-load-acceptance.mjs"], { env: { ...process.env, NODE8_LOAD_BASE_URL: "https://node.example.test" }, encoding: "utf8" });
    expect(result.status).toBe(1); expect(JSON.parse(result.stdout)).toMatchObject({ accepted: false, containsCredential: false });
  });
});

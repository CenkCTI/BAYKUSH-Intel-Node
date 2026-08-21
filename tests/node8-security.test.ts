import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  configuredApiCredentials,
  type ApiCredential,
} from "../src/api/auth.js";
import { InMemoryApiRateLimiter } from "../src/api/rate-limit.js";
import { resolveSecret } from "../src/security/secrets.js";
import type { createApiServer as CreateApiServer } from "../src/api/server.js";

const TOKEN_A = "node8-credential-a-that-is-at-least-32-bytes";
const TOKEN_B = "node8-credential-b-that-is-at-least-32-bytes";
const servers: Server[] = [];
const tempDirs: string[] = [];
let createApiServer: typeof CreateApiServer;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
  ({ createApiServer } = await import("../src/api/server.js"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function startServer(credentials: readonly ApiCredential[], rateLimiter?: InMemoryApiRateLimiter) {
  const server = rateLimiter
    ? createApiServer({ apiCredentials: credentials, rateLimiter })
    : createApiServer({ apiCredentials: credentials });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function get(base: string, route: string, token?: string) {
  return token
    ? fetch(`${base}${route}`, { headers: { authorization: `Bearer ${token}` } })
    : fetch(`${base}${route}`);
}

describe("NODE-8 secret and service-auth boundary", () => {
  it("loads bounded newline-terminated secrets from absolute files and rejects ambiguous configuration", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "node8-secret-"));
    tempDirs.push(directory);
    const file = path.join(directory, "secret");
    writeFileSync(file, `${TOKEN_A}\n`, { mode: 0o600 });

    expect(resolveSecret({ TEST_SECRET_FILE: file }, "TEST_SECRET")).toBe(TOKEN_A);
    expect(() => resolveSecret({ TEST_SECRET: TOKEN_A, TEST_SECRET_FILE: file }, "TEST_SECRET"))
      .toThrow(/mutually exclusive/u);
    expect(() => resolveSecret({ TEST_SECRET_FILE: "relative/path" }, "TEST_SECRET"))
      .toThrow(/absolute path/u);
  });

  it("loads a rotating multi-credential registry with explicit scopes", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "node8-registry-"));
    tempDirs.push(directory);
    const registry = path.join(directory, "api-credentials.json");
    writeFileSync(registry, JSON.stringify({ credentials: [
      { id: "citem-current", token: TOKEN_A, scopes: ["techint:read", "sources:read"] },
      { id: "citem-next", token: TOKEN_B, scopes: ["techint:read"] },
    ] }), { mode: 0o600 });

    const credentials = configuredApiCredentials({ BAYKUSH_NODE_API_CREDENTIALS_FILE: registry });
    expect(credentials.map((credential) => credential.id)).toEqual(["citem-current", "citem-next"]);
    expect(credentials[1]?.scopes).toEqual(["techint:read"]);
  });

  it("accepts both credentials during rotation and enforces endpoint scopes", async () => {
    const credentials: ApiCredential[] = [
      { id: "current", token: TOKEN_A, scopes: ["techint:read", "sources:read"] },
      { id: "next", token: TOKEN_B, scopes: ["techint:read"] },
    ];
    const base = await startServer(credentials);

    expect((await get(base, "/v1/techint/measurement-catalog", TOKEN_A)).status).toBe(200);
    expect((await get(base, "/v1/techint/measurement-catalog", TOKEN_B)).status).toBe(200);
    expect((await get(base, "/v1/techint/measurement-catalog", "not-a-valid-service-credential")).status).toBe(401);
    expect((await get(base, "/v1/sources", TOKEN_B)).status).toBe(403);
  });

  it("rate-limits authenticated clients without leaking their credential", async () => {
    const limiter = new InMemoryApiRateLimiter({ windowMs: 60_000, standardLimit: 1, expensiveLimit: 1 });
    const base = await startServer([
      { id: "rate-test", token: TOKEN_A, scopes: ["techint:read"] },
    ], limiter);

    const first = await get(base, "/v1/techint/measurement-catalog", TOKEN_A);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-ratelimit-remaining")).toBe("0");

    const second = await get(base, "/v1/techint/measurement-catalog", TOKEN_A);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBeTruthy();
    expect(await second.text()).not.toContain(TOKEN_A);
  });

  it("adds API hardening headers while keeping browser CORS closed", async () => {
    const base = await startServer([
      { id: "headers", token: TOKEN_A, scopes: ["techint:read"] },
    ]);
    const response = await get(base, "/v1/techint/measurement-catalog", TOKEN_A);

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

import type { AddressInfo } from "node:net";
import type { createApiServer as CreateApiServer } from "../src/api/server.js";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";

const TOKEN = "node4-test-token-that-is-at-least-32-bytes";
const servers: Server[] = [];
let createApiServer: typeof CreateApiServer;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
  ({ createApiServer } = await import("../src/api/server.js"));
});

async function request(path: string, init?: RequestInit, token: string | null = null) {
  const server = createApiServer({ apiToken: TOKEN });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers });
  return { response, body: await response.json() as Record<string, unknown> };
}

afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("NODE-4 authenticated API boundary", () => {
  it("rejects missing and invalid credentials without echoing tokens", async () => {
    expect((await request("/v1/techint/measurement-catalog")).response.status).toBe(401);
    const invalid = await request("/v1/techint/measurement-catalog", undefined, "never-return-this-token");
    expect(invalid.response.status).toBe(401);
    expect(JSON.stringify(invalid.body)).not.toContain("never-return-this-token");
    expect((invalid.body.error as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("accepts the configured credential and preserves normal responses", async () => {
    const result = await request("/v1/techint/measurement-catalog", undefined, TOKEN);
    expect(result.response.status).toBe(200);
    expect(result.body.apiVersion).toBe("v1");
    expect(JSON.stringify(result.body)).not.toContain(TOKEN);
  });

  it("fails closed when the credential is absent or weak", async () => {
    const server = createApiServer({ apiToken: null }); servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address=server.address() as AddressInfo;
    const response=await fetch(`http://127.0.0.1:${address.port}/v1/techint/measurement-catalog`,{headers:{authorization:"Bearer any-token-that-is-long-enough-to-look-valid"}});
    expect(response.status).toBe(401);
  });

  it("returns controlled method and query errors", async () => {
    const method = await request("/v1/techint/measurements", { method: "POST" }, TOKEN);
    expect(method.response.status).toBe(405);
    expect((method.body.error as { code: string }).code).toBe("METHOD_NOT_ALLOWED");
    const invalid = await request("/v1/techint/measurements", undefined, TOKEN);
    expect(invalid.response.status).toBe(400);
    expect((invalid.body.error as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("keeps public liveness minimal", async () => {
    const health = await request("/v1/health");
    expect(health.response.status).toBe(200);
    expect(health.body.data).toEqual({ status: "ok", apiVersion: "v1" });
    expect(JSON.stringify(health.body)).not.toMatch(/database|heartbeat|instance|token/i);
  });
});

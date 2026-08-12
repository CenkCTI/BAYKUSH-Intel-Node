import { describe, expect, it } from "vitest";
import { fetchBoundedJson, parseRetryAfterSeconds } from "../src/http/source-http.js";
import { CollectionFailure } from "../src/runtime/failure.js";
import { retryDelaySeconds } from "../src/runtime/retry.js";

const endpoint = new URL("https://example.test/feed.json");

function request(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof fetchBoundedJson>[0]> = {}) {
  return fetchBoundedJson({
    url: endpoint,
    allowedHost: "example.test",
    allowedPath: "/feed.json",
    maxBytes: 1024,
    timeoutMs: 5_000,
    fetchImpl,
    ...overrides,
  });
}

describe("source HTTP transport", () => {
  it("parses bounded JSON from the fixed endpoint", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json", etag: "fixture-v1" },
    })) as typeof fetch;
    const response = await request(fakeFetch);
    expect(response.json).toEqual({ ok: true });
    expect(response.etag).toBe("fixture-v1");
  });

  it("supports a bounded POST body without changing GET defaults", async () => {
    let observedMethod: string | undefined;
    let observedBody: string | undefined;
    let observedAuth: string | null = null;
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      observedMethod = init?.method;
      observedBody = typeof init?.body === "string" ? init.body : undefined;
      observedAuth = new Headers(init?.headers).get("Auth-Key");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    await request(fakeFetch, {
      method: "POST",
      body: '{"query":"get_iocs","days":1}',
      maxRequestBytes: 1024,
      headers: { "content-type": "application/json", "Auth-Key": "fixture-key" },
    });

    expect(observedMethod).toBe("POST");
    expect(observedBody).toBe('{"query":"get_iocs","days":1}');
    expect(observedAuth).toBe("fixture-key");
  });

  it("rejects GET request bodies before transport", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(request(fakeFetch, { body: "{}" })).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      retryable: false,
    });
    expect(called).toBe(false);
  });

  it("fails closed when a POST body crosses the request byte bound", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(request(fakeFetch, {
      method: "POST",
      body: "x".repeat(33),
      maxRequestBytes: 32,
    })).rejects.toMatchObject({ code: "PAYLOAD_LIMIT_EXCEEDED", retryable: false });
    expect(called).toBe(false);
  });

  it("rejects requests outside the fixed provider endpoint before transport", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch;
    await expect(request(fakeFetch, { url: new URL("https://other.test/feed.json") })).rejects.toMatchObject({
      code: "SCHEMA_ERROR",
      retryable: false,
    });
    expect(called).toBe(false);
  });

  it("redacts exact secret values from provider diagnostic headers", async () => {
    const secret = "never-log-me";
    const fakeFetch = (async () => new Response("unauthorized", {
      status: 401,
      headers: { message: `bad key ${secret}` },
    })) as typeof fetch;
    try {
      await request(fakeFetch, { redactValues: [secret] });
      throw new Error("expected authentication failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionFailure);
      expect(String((error as Error).message)).not.toContain(secret);
      expect(String((error as Error).message)).toContain("[REDACTED]");
    }
  });

  it("carries Retry-After from a 429 response", async () => {
    const fakeFetch = (async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "120" },
    })) as typeof fetch;
    try {
      await request(fakeFetch);
      throw new Error("expected rate-limit failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionFailure);
      expect(error).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 120 });
    }
  });

  it("fails closed when a chunked body crosses the byte bound", async () => {
    const fakeFetch = (async () => new Response("x".repeat(2048), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    await expect(request(fakeFetch)).rejects.toMatchObject({ code: "PAYLOAD_LIMIT_EXCEEDED" });
  });
});

describe("retry policy", () => {
  it("uses bounded exponential delay and never retries earlier than provider Retry-After", () => {
    expect(retryDelaySeconds({ attemptCount: 1, baseSeconds: 5, maxSeconds: 300 })).toBe(5);
    expect(retryDelaySeconds({ attemptCount: 3, baseSeconds: 5, maxSeconds: 300 })).toBe(20);
    expect(retryDelaySeconds({ attemptCount: 10, baseSeconds: 5, maxSeconds: 300 })).toBe(300);
    expect(retryDelaySeconds({
      attemptCount: 1,
      baseSeconds: 5,
      maxSeconds: 300,
      providerRetryAfterSeconds: 600,
    })).toBe(600);
  });

  it("parses both numeric and HTTP-date Retry-After forms", () => {
    expect(parseRetryAfterSeconds("12", 0)).toBe(12);
    expect(parseRetryAfterSeconds("Thu, 01 Jan 1970 00:00:30 GMT", 0)).toBe(30);
  });
});

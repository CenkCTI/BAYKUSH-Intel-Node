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

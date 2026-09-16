import { describe, expect, it } from "vitest";
import { fetchBoundedJson } from "../src/http/source-http.js";
import { isForbiddenSourceHostname, isPublicInternetAddress } from "../src/http/public-address.js";

const fakeFetch = (async () => new Response('{"ok":true}', {
  status: 200,
  headers: { "content-type": "application/json" },
})) as typeof fetch;

describe("NODE-8 upstream network boundary", () => {
  it("classifies public versus private/reserved destination addresses", () => {
    expect(isPublicInternetAddress("8.8.8.8")).toBe(true);
    expect(isPublicInternetAddress("1.1.1.1")).toBe(true);
    expect(isPublicInternetAddress("127.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("0.0.0.0")).toBe(false);
    expect(isPublicInternetAddress("10.10.10.10")).toBe(false);
    expect(isPublicInternetAddress("172.16.0.1")).toBe(false);
    expect(isPublicInternetAddress("172.31.255.254")).toBe(false);
    expect(isPublicInternetAddress("169.254.169.254")).toBe(false);
    expect(isPublicInternetAddress("192.168.1.1")).toBe(false);
    expect(isPublicInternetAddress("100.64.0.1")).toBe(false);
    expect(isPublicInternetAddress("192.0.2.1")).toBe(false);
    expect(isPublicInternetAddress("224.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("255.255.255.255")).toBe(false);
    expect(isPublicInternetAddress("::1")).toBe(false);
    expect(isPublicInternetAddress("fc00::1")).toBe(false);
    expect(isPublicInternetAddress("fdff::1")).toBe(false);
    expect(isPublicInternetAddress("fe80::1")).toBe(false);
    expect(isPublicInternetAddress("2001:db8::1")).toBe(false);
    expect(isPublicInternetAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicInternetAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects metadata and local hostname classes", () => {
    expect(isForbiddenSourceHostname("localhost")).toBe(true);
    expect(isForbiddenSourceHostname("metadata.google.internal")).toBe(true);
    expect(isForbiddenSourceHostname("metadata.oraclecloud.com")).toBe(true);
    expect(isForbiddenSourceHostname("anything.local")).toBe(true);
    expect(isForbiddenSourceHostname("example.com")).toBe(false);
  });

  it("rejects an exact fixed endpoint when the endpoint itself is a private literal", async () => {
    await expect(fetchBoundedJson({
      url: new URL("https://127.0.0.1/feed.json"),
      allowedHost: "127.0.0.1",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR", retryable: false });
  });

  it("rejects a provider hostname that resolves to a private destination", async () => {
    await expect(fetchBoundedJson({
      url: new URL("https://provider.example/feed.json"),
      allowedHost: "provider.example",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
      resolveHost: async () => ["169.254.169.254"],
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR", retryable: false });
  });

  it("rejects a provider hostname that resolves to private IPv6", async () => {
    await expect(fetchBoundedJson({
      url: new URL("https://provider.example/feed.json"),
      allowedHost: "provider.example",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
      resolveHost: async () => ["fd00::1234"],
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR", retryable: false });
  });

  it("fails closed when DNS returns mixed public and private answers", async () => {
    await expect(fetchBoundedJson({
      url: new URL("https://provider.example/feed.json"),
      allowedHost: "provider.example",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
      resolveHost: async () => ["8.8.8.8", "::1"],
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR", retryable: false });
  });

  it("allows the deterministic transport when all resolved addresses are public", async () => {
    const result = await fetchBoundedJson({
      url: new URL("https://provider.example/feed.json"),
      allowedHost: "provider.example",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
      resolveHost: async () => ["8.8.8.8", "2606:4700:4700::1111"],
    });
    expect(result.json).toEqual({ ok: true });
  });

  it("classifies DNS resolution failure as bounded retryable transport failure", async () => {
    await expect(fetchBoundedJson({
      url: new URL("https://provider.example/feed.json"),
      allowedHost: "provider.example",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
      resolveHost: async () => { throw new Error("fixture dns failure"); },
    })).rejects.toMatchObject({ code: "TRANSPORT_ERROR", retryable: true });
  });

  it("classifies an empty DNS answer as bounded retryable transport failure", async () => {
    await expect(fetchBoundedJson({
      url: new URL("https://provider.example/feed.json"),
      allowedHost: "provider.example",
      allowedPath: "/feed.json",
      maxBytes: 1024,
      timeoutMs: 1000,
      fetchImpl: fakeFetch,
      resolveHost: async () => [],
    })).rejects.toMatchObject({ code: "TRANSPORT_ERROR", retryable: true });
  });
});

import { describe, expect, it, vi } from "vitest";
import { exactCanonicalIp, ipinfoLiteLookupUrl, lookupIpinfoLite } from "../src/discovery/geography/ipinfo-lite.js";

describe("NODE-7 geography provider boundary", () => {
  it("accepts only literal canonical IP subjects", () => {
    expect(exactCanonicalIp("192.0.2.10")).toBe("192.0.2.10");
    expect(exactCanonicalIp("2001:db8::10")).toBe("2001:db8::10");
    expect(() => exactCanonicalIp("https://example.com")).toThrow();
    expect(() => exactCanonicalIp("example.com")).toThrow();
  });

  it("constructs a fixed-origin URL rather than accepting an arbitrary provider URL", () => {
    const url = ipinfoLiteLookupUrl("2001:db8::10", "secret-token");
    expect(url.origin).toBe("https://api.ipinfo.io");
    expect(url.pathname).toBe("/lite/2001%3Adb8%3A%3A10");
    expect(url.searchParams.get("token")).toBe("secret-token");
  });

  it("normalizes country-level current snapshot data and keeps ASN as context", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ip: "192.0.2.10",
      country_code: "PL",
      country: "Poland",
      continent_code: "EU",
      continent: "Europe",
      asn: "AS64500",
      as_name: "Example ASN",
      as_domain: "example.invalid",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await lookupIpinfoLite({
      ip: "192.0.2.10",
      token: "secret-token",
      timeoutMs: 8_000,
      fetchImpl,
      now: () => new Date("2026-08-18T12:00:00.000Z"),
    });

    expect(result.countryCode).toBe("PL");
    expect(result.asn).toBe("AS64500");
    expect(result.lookedUpAt).toBe("2026-08-18T12:00:00.000Z");
    expect(result.responseSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a provider response for a different IP", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ip: "192.0.2.11",
      country_code: "PL",
    }), { status: 200 }));
    await expect(lookupIpinfoLite({
      ip: "192.0.2.10",
      token: "secret-token",
      timeoutMs: 8_000,
      fetchImpl,
    })).rejects.toThrow("does not match");
  });
});

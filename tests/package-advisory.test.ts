import { describe, expect, it } from "vitest";
import { createPackageAdvisoryAdapter } from "../src/sources/package-advisory.js";

const reviewed = {
  ghsa_id: "GHSA-aaaa-bbbb-cccc",
  cve_id: "CVE-2026-1234",
  html_url: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
  summary: "Fixture advisory",
  type: "reviewed",
  severity: "high",
  published_at: "2026-08-13T10:00:00Z",
  updated_at: "2026-08-13T11:00:00Z",
  identifiers: [{ type: "CVE", value: "CVE-2026-1234" }],
  references: ["https://example.com/reference"],
  vulnerabilities: [{ package: { ecosystem: "npm", name: "Example-Package" }, first_patched_version: { identifier: "1.2.3" }, vulnerable_version_range: "< 1.2.3" }],
};

function jsonFetch(payload: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("reviewed package advisory source", () => {
  it("preserves GHSA identity and source publication/update time", async () => {
    const adapter = createPackageAdvisoryAdapter({ fetchImpl: jsonFetch([reviewed]), now: () => Date.parse("2026-08-13T12:00:00Z") });
    const work = await adapter.plan({ checkpoint: null });
    const result = await adapter.fetch({ work, signal: new AbortController().signal });
    expect(result.complete).toBe(true);
    expect(adapter.identifyRawRecord(result.records[0])).toBe("GHSA-aaaa-bbbb-cccc");
    expect(adapter.extractTimes(result.records[0])).toEqual({ publishedAt: "2026-08-13T10:00:00Z", effectiveAt: "2026-08-13T10:00:00Z", upstreamUpdatedAt: "2026-08-13T11:00:00Z" });
  });

  it("rejects unreviewed records in this source contract", async () => {
    const adapter = createPackageAdvisoryAdapter({ fetchImpl: jsonFetch([{ ...reviewed, type: "unreviewed" }]) });
    try {
      await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
      throw new Error("expected reviewed-only schema rejection");
    } catch (error) {
      expect(adapter.classifyFailure(error)).toMatchObject({ code: "SCHEMA_ERROR", retryable: false });
    }
  });

  it("normalizes a security advisory and CVE evidence without deriving risk", async () => {
    const adapter = createPackageAdvisoryAdapter({ fetchImpl: jsonFetch([reviewed]) });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    const canonical = adapter.normalize(adapter.rawPayload(result.records[0]))[0];
    expect(canonical?.recordKind).toBe("SECURITY_ADVISORY");
    expect(canonical?.entities).toContainEqual({ kind: "CVE", key: "CVE-2026-1234", label: "CVE-2026-1234" });
  });

  it("fails closed when a modified-time window reaches the provider page limit", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ ...reviewed, ghsa_id: `GHSA-aaaa-bbbb-${String(i).padStart(4, "0")}` }));
    const adapter = createPackageAdvisoryAdapter({ fetchImpl: jsonFetch(fullPage) });
    try {
      await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
      throw new Error("expected saturated-window failure");
    } catch (error) {
      expect(adapter.classifyFailure(error).code).toBe("PAYLOAD_LIMIT_EXCEEDED");
    }
  });
});

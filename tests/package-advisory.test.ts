import { describe, expect, it } from "vitest";
import { createNode5PackageSource } from "../src/sources/node5-package-source.js";

const reviewed = {
  ghsa_id: "ADVISORY-FIXTURE-1",
  cve_id: null,
  html_url: "https://example.com/advisories/fixture-1",
  summary: "Fixture package advisory",
  type: "reviewed",
  severity: "high",
  published_at: "2026-08-13T10:00:00Z",
  updated_at: "2026-08-13T11:00:00Z",
  identifiers: [],
  references: ["https://example.com/reference"],
  vulnerabilities: [{ package: { ecosystem: "npm", name: "example-package" }, first_patched_version: { identifier: "1.2.3" }, vulnerable_version_range: "< 1.2.3" }],
};

function jsonFetch(payload: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("reviewed package source runtime contract", () => {
  it("normalizes the persisted raw payload", async () => {
    const adapter = createNode5PackageSource({ fetchImpl: jsonFetch([reviewed]), now: () => Date.parse("2026-08-13T12:00:00Z") });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    const raw = adapter.rawPayload(result.records[0]);
    const canonical = adapter.normalize(raw)[0];
    expect(canonical?.recordKind).toBe("SECURITY_ADVISORY");
    expect(canonical?.canonicalKey).toContain("advisory-fixture-1");
  });

  it("preserves published and updated time", async () => {
    const adapter = createNode5PackageSource({ fetchImpl: jsonFetch([reviewed]) });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(adapter.extractTimes(result.records[0])).toEqual({ publishedAt: reviewed.published_at, effectiveAt: reviewed.published_at, upstreamUpdatedAt: reviewed.updated_at });
  });

  it("rejects non-reviewed records", async () => {
    const adapter = createNode5PackageSource({ fetchImpl: jsonFetch([{ ...reviewed, type: "unreviewed" }]) });
    await expect(adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal })).rejects.toBeTruthy();
  });

  it("fails closed when a source window saturates its page bound", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ ...reviewed, ghsa_id: `ADVISORY-FIXTURE-${index}` }));
    const adapter = createNode5PackageSource({ fetchImpl: jsonFetch(fullPage) });
    try {
      await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
      throw new Error("expected bounded-window failure");
    } catch (error) {
      expect(adapter.classifyFailure(error).code).toBe("PAYLOAD_LIMIT_EXCEEDED");
    }
  });
});

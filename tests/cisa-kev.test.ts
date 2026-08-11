import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CollectionFailure } from "../src/runtime/failure.js";
import {
  createCisaKevAdapter,
  extractCisaKevNoteUrls,
  normalizeCisaKevEntry,
  validateCisaKevCatalog,
} from "../src/sources/cisa-kev.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/cisa-kev/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function responseJson(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(status === 304 ? null : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("CISA KEV source adapter", () => {
  it("declares conservative production source semantics and remains disabled by default", () => {
    const adapter = createCisaKevAdapter();
    expect(adapter.definition.sourceKey).toBe("CISA_KEV");
    expect(adapter.definition.collectionMode).toBe("SNAPSHOT");
    expect(adapter.definition.recoveryStrategy).toBe("SNAPSHOT_RECONSTRUCTION");
    expect(adapter.definition.enabledByDefault).toBe(false);
    expect(adapter.definition.licenseClass).toBe("CC0-1.0");
    expect(adapter.maxRecordsPerWorkUnit).toBe(5001);
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("exploit-event counts");
  });

  it("validates the complete catalog atomically and preserves additive raw fields", () => {
    const parsed = validateCisaKevCatalog(fixture("catalog-v1.json"));
    expect(parsed.count).toBe(3);
    expect(parsed.vulnerabilities).toHaveLength(3);
    expect(parsed.vulnerabilities[0]?.futureAdditiveField).toBe("preserve-me");
    expect(() => validateCisaKevCatalog(fixture("invalid-count.json"))).toThrow(CollectionFailure);
    expect(() => validateCisaKevCatalog(fixture("invalid-entry.json"))).toThrow();
    expect(() => validateCisaKevCatalog(fixture("duplicate-cve.json"))).toThrow(CollectionFailure);
  });

  it("normalizes KEV membership without inventing attack counts or ransomware false", () => {
    const parsed = validateCisaKevCatalog(fixture("catalog-v1.json"));
    const draft = normalizeCisaKevEntry(parsed.vulnerabilities[0]);
    expect(draft.recordKind).toBe("KNOWN_EXPLOITED_VULNERABILITY");
    expect(draft.canonicalKey).toBe("cve:CVE-2026-10001");
    expect(draft.entities.find((entity) => entity.kind === "CVE")?.key).toBe("CVE-2026-10001");
    expect(draft.entities.find((entity) => entity.kind === "VENDOR")?.key).toMatch(/^vendor:cisa-kev:[a-f0-9]{64}$/);
    expect(draft.entities.find((entity) => entity.kind === "PRODUCT")?.key).toMatch(/^product:cisa-kev:[a-f0-9]{64}$/);
    expect(draft.facts).toContainEqual({ predicate: "kev.known_ransomware_campaign_use", value: "Unknown" });
    expect(draft.facts).toContainEqual({ predicate: "kev.date_added", value: "2026-08-11" });
    expect(draft.facts.some((fact) => fact.predicate.includes("attack"))).toBe(false);
  });

  it("extracts only safe HTTP(S) references from notes", () => {
    expect(extractCisaKevNoteUrls(
      "https://vendor.example/a ; javascript:alert(1) ; https://example.org/path). http://example.net/x",
    )).toEqual([
      "https://vendor.example/a",
      "https://example.org/path",
      "http://example.net/x",
    ]);
  });

  it("uses one bounded snapshot request, preserves date-only precision, and supports conditional 304", async () => {
    const payload = fixture("catalog-v1.json");
    const calls: Array<{ url: string; headers: Headers }> = [];
    let request = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      request += 1;
      if (request === 1) return responseJson(payload, 200, { etag: '"fixture-v1"', "last-modified": "Tue, 11 Aug 2026 18:00:00 GMT" });
      return responseJson(null, 304, { etag: '"fixture-v1"' });
    };
    const adapter = createCisaKevAdapter({ fetchImpl });
    const firstPlan = await adapter.plan({ checkpoint: null });
    const first = await adapter.fetch({ work: firstPlan, signal: new AbortController().signal });
    expect(first.records).toHaveLength(4);
    expect(first.complete).toBe(true);
    const entry = first.records[0];
    expect(adapter.identifyRawRecord(entry)).toBe("CVE-2026-10001");
    expect(adapter.extractTimes(entry)).toEqual({ publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null });
    expect((adapter.rawPayload(entry) as Record<string, unknown>).futureAdditiveField).toBe("preserve-me");

    const secondPlan = await adapter.plan({ checkpoint: first.nextCheckpoint });
    const second = await adapter.fetch({ work: secondPlan, signal: new AbortController().signal });
    expect(second.records).toHaveLength(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get("if-none-match")).toBe('"fixture-v1"');
  });

  it("falls back to the canonical cisa.gov feed without creating a second upstream origin", async () => {
    const payload = fixture("catalog-v1.json");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("raw.githubusercontent.com")) return new Response("unavailable", { status: 503 });
      return responseJson(payload, 200, { etag: '"cisa-v1"' });
    };
    const adapter = createCisaKevAdapter({ fetchImpl });
    const plan = await adapter.plan({ checkpoint: null });
    const result = await adapter.fetch({ work: plan, signal: new AbortController().signal });
    expect(result.records).toHaveLength(4);
    expect(adapter.sourceReference(result.records[0])).toContain("www.cisa.gov/sites/default/files/feeds/");
    expect(adapter.definition.upstreamOriginKey).toBe("CISA_KEV");
  });

  it("rejects responses above the eight MiB bound", async () => {
    const fetchImpl: typeof fetch = async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(8 * 1024 * 1024 + 1),
      },
    });
    const adapter = createCisaKevAdapter({ fetchImpl });
    const plan = await adapter.plan({ checkpoint: null });
    await expect(adapter.fetch({ work: plan, signal: new AbortController().signal })).rejects.toMatchObject({
      code: "PAYLOAD_LIMIT_EXCEEDED",
    });
  });
});

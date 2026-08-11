import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  nvdCveResponseSchema,
} from "../src/sources/nvd-cve.js";
import {
  createNvdCveAdapterV2,
  normalizeNvdCveV2,
} from "../src/sources/nvd-cve-normalization-v2.js";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`./fixtures/nvd-cve/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function responseJson(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function firstCve(name: string): unknown {
  const parsed = nvdCveResponseSchema.parse(fixture(name));
  const cve = parsed.vulnerabilities[0]?.cve;
  if (!cve) throw new Error(`fixture ${name} has no CVE`);
  return cve;
}

describe("NVD CVE production adapter", () => {
  it("declares conservative source semantics, optional auth, and remains disabled", () => {
    const adapter = createNvdCveAdapterV2();
    expect(adapter.definition.sourceKey).toBe("NVD_CVE");
    expect(adapter.definition.sourceClass).toBe("VULNERABILITY_DATABASE");
    expect(adapter.definition.observationBasis).toBe("ENRICHED");
    expect(adapter.definition.collectionMode).toBe("PAGED_POLL");
    expect(adapter.definition.defaultPollIntervalSeconds).toBe(7200);
    expect(adapter.definition.minimumPollIntervalSeconds).toBe(7200);
    expect(adapter.definition.authRequirement).toBe("OPTIONAL");
    expect(adapter.definition.requiresAuth).toBe(false);
    expect(adapter.definition.enabledByDefault).toBe(false);
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("exploit probability");
    expect(adapter.definition.semanticContractVersion).toBe("nvd-cve-semantics-v2");
    expect(adapter.normalizationVersion).toBe("nvd-cve-normalization-v2");
    expect(adapter.maxRecordsPerWorkUnit).toBe(2000);
    expect(adapter.maxRawRecordBytes).toBe(4 * 1024 * 1024);
  });

  it("creates a frozen 24-hour bootstrap window and sends an optional key only in the header", async () => {
    const calls: Array<{ url: URL; headers: Headers }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return responseJson(fixture("page-1.json"));
    };
    const adapter = createNvdCveAdapterV2({
      apiKey: "fixture-secret",
      pageSize: 2,
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      sleep: async () => {},
      fetchImpl,
    });
    const work = await adapter.plan({ checkpoint: null });
    const result = await adapter.fetch({ work, signal: new AbortController().signal });
    expect(result.records).toHaveLength(2);
    expect(result.complete).toBe(false);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.headers.get("apiKey")).toBe("fixture-secret");
    expect(call?.url.searchParams.get("lastModStartDate")).toBe("2026-08-11T00:00:00.000Z");
    expect(call?.url.searchParams.get("lastModEndDate")).toBe("2026-08-12T00:00:00.000Z");
    expect(call?.url.searchParams.get("resultsPerPage")).toBe("2");
    expect(call?.url.searchParams.get("startIndex")).toBe("0");
    expect(call?.url.toString()).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(adapter.sourceReference(result.records[0])).not.toContain("fixture-secret");
    const raw = adapter.rawPayload(result.records[0]) as Record<string, unknown>;
    expect(raw.futureAdditiveField).toBe("preserve-me");
    expect(raw.cisaExploitAdd).toBe("2026-08-11");
  });

  it("restarts the same fixed window when totalResults drifts instead of advancing silently", async () => {
    let request = 0;
    const pageOne = fixture("page-1.json");
    const drifted = {
      resultsPerPage: 2,
      startIndex: 2,
      totalResults: 4,
      version: "2.0",
      vulnerabilities: [
        ...nvdCveResponseSchema.parse(fixture("page-2.json")).vulnerabilities,
        { cve: {
          id: "CVE-2026-10004",
          sourceIdentifier: "cna@example.test",
          published: "2026-08-11T19:10:00.000Z",
          lastModified: "2026-08-11T23:10:00.000Z",
          vulnStatus: "Received",
        } },
      ],
    };
    const fetchImpl: typeof fetch = async () => responseJson(request++ === 0 ? pageOne : drifted);
    const adapter = createNvdCveAdapterV2({
      pageSize: 2,
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      sleep: async () => {},
      fetchImpl,
    });
    const first = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(first.nextWork).not.toBeNull();
    const drift = await adapter.fetch({ work: first.nextWork, signal: new AbortController().signal });
    expect(drift.records).toHaveLength(0);
    expect(drift.complete).toBe(false);
    expect(drift.nextWork).toMatchObject({ startIndex: 0, expectedTotalResults: null, restartCount: 1 });
    expect(drift.nextCheckpoint).toMatchObject({ completedThrough: null, activeWindow: { startIndex: 0, restartCount: 1 } });
  });

  it("treats a zero-result HTTP 200 window as a valid observed zero", async () => {
    const adapter = createNvdCveAdapterV2({
      now: () => Date.parse("2026-08-12T04:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async () => responseJson(fixture("zero-results.json")),
    });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(result.records).toHaveLength(0);
    expect(result.complete).toBe(true);
    expect(result.nextCheckpoint).toMatchObject({ completedThrough: "2026-08-12T04:00:00.000Z", activeWindow: null });
  });

  it("preserves mixed NVD metric families without mislabeling the container as CVSS-only", () => {
    const rejected = normalizeNvdCveV2(firstCve("rejected-cve.json"));
    expect(rejected.recordKind).toBe("VULNERABILITY_RECORD");
    expect(rejected.facts).toContainEqual({ predicate: "nvd.vuln_status", value: "Rejected" });

    const mixed = structuredClone(firstCve("multiple-cvss.json")) as Record<string, unknown>;
    const sourceMetrics = mixed.metrics as Record<string, unknown>;
    sourceMetrics.ssvcV203 = [{
      source: "cisa@example.test",
      ssvcData: {
        role: "CISA Coordinator",
        version: "2.0.3",
        options: [{ exploitation: "none" }],
      },
    }];
    const multiple = normalizeNvdCveV2(mixed);
    const metrics = multiple.facts.find((fact) => fact.predicate === "nvd.metrics")?.value as Record<string, unknown>;
    expect(JSON.stringify(metrics)).toContain("nvd@nist.gov");
    expect(JSON.stringify(metrics)).toContain("vendor@example.test");
    expect(JSON.stringify(metrics)).toContain("ssvcV203");
    expect(JSON.stringify(metrics)).toContain("CISA Coordinator");
    expect(multiple.facts.some((fact) => fact.predicate === "nvd.cvss_metrics")).toBe(false);

    const additive = firstCve("additive-fields.json") as Record<string, unknown>;
    const draft = normalizeNvdCveV2(additive);
    expect(additive.futureNvdField).toEqual({ nested: "preserve" });
    expect(draft.facts).toContainEqual({ predicate: "nvd.vuln_status", value: "FutureStatus" });
    expect(draft.facts.some((fact) => fact.predicate.toLowerCase().includes("cisa"))).toBe(false);
    expect(draft.recordKind).not.toBe("KNOWN_EXPLOITED_VULNERABILITY");
  });

  it("keeps complex CPE applicability in raw truth and only emits explicit count metadata", () => {
    const cve = firstCve("complex-cpe.json") as Record<string, unknown>;
    const draft = normalizeNvdCveV2(cve);
    expect(cve.configurations).toBeDefined();
    expect(draft.entities).toHaveLength(1);
    expect(draft.entities[0]?.kind).toBe("CVE");
    expect(draft.facts).toContainEqual({ predicate: "nvd.configuration_present", value: true });
    expect(draft.facts).toContainEqual({ predicate: "nvd.cpe_match_count", value: 3 });
  });

  it("redacts an API key if a provider diagnostic header echoes it", async () => {
    const adapter = createNvdCveAdapterV2({
      apiKey: "super-secret-key",
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async () => new Response("denied", {
        status: 403,
        headers: { message: "invalid apiKey super-secret-key" },
      }),
    });
    try {
      await adapter.fetch({
        work: await adapter.plan({ checkpoint: null }),
        signal: new AbortController().signal,
      });
      throw new Error("expected NVD authentication failure");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("[REDACTED]");
      expect(message).not.toContain("super-secret-key");
    }
  });

  it("fails closed on pagination index mismatch and an oversized response declaration", async () => {
    const mismatch = { ...nvdCveResponseSchema.parse(fixture("page-1.json")), startIndex: 1 };
    const mismatchAdapter = createNvdCveAdapterV2({
      pageSize: 2,
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async () => responseJson(mismatch),
    });
    await expect(mismatchAdapter.fetch({
      work: await mismatchAdapter.plan({ checkpoint: null }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR" });

    const oversizedAdapter = createNvdCveAdapterV2({
      now: () => Date.parse("2026-08-12T00:00:00.000Z"),
      sleep: async () => {},
      fetchImpl: async () => new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(64 * 1024 * 1024 + 1) },
      }),
    });
    await expect(oversizedAdapter.fetch({
      work: await oversizedAdapter.plan({ checkpoint: null }),
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "PAYLOAD_LIMIT_EXCEEDED" });
  });
});

import { describe, expect, it } from "vitest";
import { createFeodoTrackerAdapter, normalizeFeodoRecord, parseFeodoUtcTimestamp } from "../src/sources/feodo-tracker.js";

const sample = {
  ip_address: "192.0.2.10",
  port: 443,
  status: "online",
  hostname: null,
  as_number: 64500,
  as_name: "TEST-AS",
  country: "PL",
  first_seen: "2026-08-13 10:20:30",
  last_online: "2026-08-13",
  malware: "ExampleBot",
};

function jsonFetch(payload: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Feodo Tracker source adapter", () => {
  it("declares conservative semantics and remains disabled by default", () => {
    const adapter = createFeodoTrackerAdapter({ fetchImpl: jsonFetch([]) });
    expect(adapter.definition.sourceKey).toBe("FEODO_TRACKER");
    expect(adapter.definition.sourceClass).toBe("IOC_SHARING");
    expect(adapter.definition.observationBasis).toBe("REPORTED");
    expect(adapter.definition.recoveryStrategy).toBe("SNAPSHOT_RECONSTRUCTION");
    expect(adapter.definition.enabledByDefault).toBe(false);
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("attack count");
  });

  it("preserves source time precision", () => {
    expect(parseFeodoUtcTimestamp(sample.first_seen)).toBe("2026-08-13T10:20:30.000Z");
    const canonical = normalizeFeodoRecord({ kind: "FEODO_C2_IOC", source: sample })[0];
    expect(canonical?.facts).toContainEqual({ predicate: "feodo.last_online_date", value: "2026-08-13" });
    expect(canonical?.facts.some((fact) => fact.predicate === "feodo.last_online")).toBe(false);
  });

  it("captures a changed snapshot and checkpoints deterministically", async () => {
    const adapter = createFeodoTrackerAdapter({ fetchImpl: jsonFetch([sample]) });
    const initialWork = await adapter.plan({ checkpoint: null });
    const first = await adapter.fetch({ work: initialWork, signal: new AbortController().signal });
    expect(first.complete).toBe(true);
    expect(first.records).toHaveLength(2);
    const entry = first.records[0];
    expect(adapter.identifyRawRecord(entry)).toMatch(/^c2:[a-f0-9]{64}$/);
    expect(adapter.extractTimes(entry)).toEqual({ publishedAt: null, effectiveAt: "2026-08-13T10:20:30.000Z", upstreamUpdatedAt: null });
    const canonical = adapter.normalize(adapter.rawPayload(entry))[0];
    expect(canonical?.recordKind).toBe("IOC_REPORT");
    expect(canonical?.entities).toContainEqual({ kind: "IP", key: "192.0.2.10", label: "192.0.2.10" });
    expect(canonical?.facts).toContainEqual({ predicate: "feodo.port", value: 443 });
    const second = await adapter.fetch({ work: first.nextCheckpoint, signal: new AbortController().signal });
    expect(second.records).toEqual([]);
    expect(second.nextCheckpoint).toEqual(first.nextCheckpoint);
  });

  it("treats a successful empty dataset as a valid snapshot", async () => {
    const adapter = createFeodoTrackerAdapter({ fetchImpl: jsonFetch([]) });
    const work = await adapter.plan({ checkpoint: null });
    const result = await adapter.fetch({ work, signal: new AbortController().signal });
    expect(result.complete).toBe(true);
    expect(result.records).toHaveLength(1);
    const manifest = adapter.rawPayload(result.records[0]) as Record<string, unknown>;
    expect(manifest.kind).toBe("FEODO_SNAPSHOT_MANIFEST");
    expect(manifest.recordCount).toBe(0);
  });

  it("keeps identity stable across mutable status changes", () => {
    const adapter = createFeodoTrackerAdapter({ fetchImpl: jsonFetch([]) });
    const left = { kind: "ENTRY", payload: { kind: "FEODO_C2_IOC", source: sample } };
    const right = { kind: "ENTRY", payload: { kind: "FEODO_C2_IOC", source: { ...sample, status: "offline", last_online: "2026-08-14" } } };
    expect(adapter.identifyRawRecord(left)).toBe(adapter.identifyRawRecord(right));
  });

  it("fails closed on malformed endpoint identity", async () => {
    const adapter = createFeodoTrackerAdapter({ fetchImpl: jsonFetch([{ ...sample, ip_address: "not-an-ip" }]) });
    const work = await adapter.plan({ checkpoint: null });
    try {
      await adapter.fetch({ work, signal: new AbortController().signal });
      throw new Error("expected schema validation to fail");
    } catch (error) {
      expect(adapter.classifyFailure(error)).toMatchObject({ code: "SCHEMA_ERROR", retryable: false });
    }
  });
});

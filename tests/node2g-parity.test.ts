import { describe, expect, it } from "vitest";
import { compareParitySnapshots, NODE2G_PARITY_SCHEMA_VERSION, type ParitySnapshot } from "../src/node2g/parity.js";

function snapshot(
  producer: "NODE" | "CITEM",
  sourceKey: ParitySnapshot["sourceKey"],
  facts: Record<string, unknown>,
  options: { sourceRecordId?: string; upstreamSnapshotId?: string | null; sourceClass?: string; observationBasis?: string } = {},
): ParitySnapshot {
  return {
    schemaVersion: NODE2G_PARITY_SCHEMA_VERSION,
    producer,
    sourceKey,
    capturedAt: "2026-08-12T13:00:00.000Z",
    upstreamSnapshotId: options.upstreamSnapshotId ?? "snapshot-1",
    window: { start: null, end: null },
    semantics: {
      sourceClass: options.sourceClass ?? (sourceKey === "CISA_KEV" ? "EXPLOITED_VULNERABILITY_CATALOG" : "IOC_SHARING"),
      observationBasis: options.observationBasis ?? (sourceKey === "CISA_KEV" ? "PUBLISHED" : "REPORTED"),
    },
    records: [{
      sourceRecordId: options.sourceRecordId ?? "record-1",
      subject: { kind: sourceKey === "CISA_KEV" ? "CVE" : "INDICATOR", value: options.sourceRecordId ?? "record-1" },
      times: { publishedAt: null, effectiveAt: null, upstreamUpdatedAt: null },
      facts,
    }],
  };
}

const cisaFacts = {
  cve: "CVE-2026-1234",
  dateAdded: "2026-08-01",
  dueDate: "2026-08-20",
  vendor: "Example",
  product: "Widget",
  ransomwareUse: "Unknown",
};

const threatFoxFacts = {
  providerId: "42",
  indicatorType: "domain",
  indicatorValue: "bad.example",
  firstSeen: "2026-08-12T12:00:00.000Z",
  lastSeen: "2026-08-12T12:30:00.000Z",
  malwareFamily: "example",
  providerConfidence: 80,
};

describe("NODE-2G neutral parity", () => {
  it("accepts exact critical source facts from the same CISA snapshot", () => {
    const result = compareParitySnapshots(snapshot("NODE", "CISA_KEV", cisaFacts), snapshot("CITEM", "CISA_KEV", cisaFacts));
    expect(result.accepted).toBe(true);
    expect(result.intersection).toBe(1);
    expect(result.blockingDifferences).toBe(0);
    expect(result.unexplainedDifferences).toBe(0);
  });

  it("treats missing exact-membership CISA records on the same snapshot as regression", () => {
    const node = snapshot("NODE", "CISA_KEV", cisaFacts);
    const citem = { ...snapshot("CITEM", "CISA_KEV", cisaFacts), records: [] };
    const result = compareParitySnapshots(node, citem);
    expect(result.accepted).toBe(false);
    expect(result.blockingDifferences).toBe(1);
    expect(result.differences[0]?.classification).toBe("REGRESSION");
  });

  it("accepts NVD ENRICHED and legacy PUBLISHED as documented source-semantic equivalence", () => {
    const facts = { cve: "CVE-2026-4321", published: "2026-08-01T00:00:00.000Z", lastModified: "2026-08-12T00:00:00.000Z", vulnStatus: "Analyzed" };
    const node = snapshot("NODE", "NVD_CVE", facts, { sourceClass: "VULNERABILITY_DATABASE", observationBasis: "ENRICHED" });
    const citem = snapshot("CITEM", "NVD_CVE", facts, { sourceClass: "VULNERABILITY_DATABASE", observationBasis: "PUBLISHED" });
    const result = compareParitySnapshots(node, citem);
    expect(result.accepted).toBe(true);
    expect(result.differences.some((difference) => difference.classification === "SEMANTICALLY_EQUIVALENT")).toBe(true);
  });

  it("compares EPSS score and percentile numerically rather than by JSON primitive type", () => {
    const node = snapshot("NODE", "FIRST_EPSS", { cve: "CVE-2026-5000", score: "0.125000", percentile: "0.9000", scoreDate: "2026-08-12" }, { sourceClass: "EXPLOIT_PROBABILITY", observationBasis: "SCORED" });
    const citem = snapshot("CITEM", "FIRST_EPSS", { cve: "CVE-2026-5000", score: 0.125, percentile: 0.9, scoreDate: "2026-08-12" }, { sourceClass: "EXPLOIT_PROBABILITY", observationBasis: "SCORED" });
    expect(compareParitySnapshots(node, citem).accepted).toBe(true);
  });

  it("compares MalwareBazaar source tags without treating provider array order as meaning", () => {
    const common = {
      sha256: "a".repeat(64), sha1: "b".repeat(40), md5: "c".repeat(32), firstSeen: "2026-08-12 12:00:00", lastSeen: null,
      fileName: "x.exe", fileSize: 100, fileType: "exe", fileTypeMime: "application/x-dosexec", signature: "Fixture", reporter: "reporter",
    };
    const node = snapshot("NODE", "MALWAREBAZAAR", { ...common, tags: ["rat", "exe"] }, { sourceRecordId: "a".repeat(64), sourceClass: "MALWARE_SAMPLE_REPOSITORY", observationBasis: "PUBLISHED" });
    const citem = snapshot("CITEM", "MALWAREBAZAAR", { ...common, tags: ["exe", "rat"] }, { sourceRecordId: "a".repeat(64), sourceClass: "MALWARE_SAMPLE_REPOSITORY", observationBasis: "PUBLISHED" });
    expect(compareParitySnapshots(node, citem).accepted).toBe(true);
  });

  it("requires live ThreatFox membership skew to be explicitly classified", () => {
    const node = snapshot("NODE", "THREATFOX", threatFoxFacts, { sourceRecordId: "42", upstreamSnapshotId: null });
    const citem = { ...snapshot("CITEM", "THREATFOX", threatFoxFacts, { sourceRecordId: "42", upstreamSnapshotId: null }), records: [] };
    const unresolved = compareParitySnapshots(node, citem);
    expect(unresolved.accepted).toBe(false);
    expect(unresolved.unexplainedDifferences).toBe(1);

    const classified = compareParitySnapshots(node, citem, [{
      side: "NODE_ONLY",
      sourceRecordId: "42",
      classification: "TEMPORAL_SKEW",
      reason: "The Node request completed after the CITEM shadow capture.",
    }]);
    expect(classified.accepted).toBe(true);
    expect(classified.unexplainedDifferences).toBe(0);
  });

  it("blocks critical fact mismatches for intersecting source identities", () => {
    const node = snapshot("NODE", "CISA_KEV", cisaFacts);
    const citem = snapshot("CITEM", "CISA_KEV", { ...cisaFacts, product: "Different Widget" });
    const result = compareParitySnapshots(node, citem);
    expect(result.accepted).toBe(false);
    expect(result.differences.some((difference) => difference.kind === "FACT_MISMATCH" && difference.field === "product")).toBe(true);
  });

  it("blocks semantic class drift even when source facts match", () => {
    const node = snapshot("NODE", "CISA_KEV", cisaFacts);
    const citem = snapshot("CITEM", "CISA_KEV", cisaFacts, { sourceClass: "IOC_SHARING" });
    const result = compareParitySnapshots(node, citem);
    expect(result.accepted).toBe(false);
    expect(result.differences.some((difference) => difference.kind === "SEMANTIC_MISMATCH" && difference.classification === "REGRESSION")).toBe(true);
  });

  it("blocks duplicate source identities inside a parity snapshot", () => {
    const node = snapshot("NODE", "THREATFOX", threatFoxFacts, { sourceRecordId: "42", upstreamSnapshotId: null });
    node.records.push(structuredClone(node.records[0]!));
    const citem = snapshot("CITEM", "THREATFOX", threatFoxFacts, { sourceRecordId: "42", upstreamSnapshotId: null });
    const result = compareParitySnapshots(node, citem);
    expect(result.accepted).toBe(false);
    expect(result.differences.some((difference) => difference.kind === "DUPLICATE_IDENTITY")).toBe(true);
  });
});

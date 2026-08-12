import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  FIRST_EPSS_CAPTURE_PROFILE,
  createFirstEpssAdapter,
  normalizeFirstEpssPayload,
  parseFirstEpssArtifact,
  parseFirstEpssMetadataLine,
} from "../src/sources/first-epss.js";

async function* chunked(buffer: Buffer, chunkSize = 137): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize));
  }
}

function gzipCsv(lines: readonly string[]): Buffer {
  return gzipSync(`${lines.join("\n")}\n`);
}

function dataset(rows: readonly string[], metadata = "#model_version:v2026.06.15,score_date:2026-08-12T00:00:00+0000"): Buffer {
  return gzipCsv([metadata, "cve,epss,percentile", ...rows]);
}

describe("FIRST EPSS production adapter", () => {
  it("declares score-only source semantics and remains disabled by default", () => {
    const adapter = createFirstEpssAdapter();
    expect(adapter.definition.sourceKey).toBe("FIRST_EPSS");
    expect(adapter.definition.sourceClass).toBe("EXPLOIT_PROBABILITY");
    expect(adapter.definition.observationBasis).toBe("SCORED");
    expect(adapter.definition.collectionMode).toBe("SNAPSHOT");
    expect(adapter.definition.authRequirement).toBe("NONE");
    expect(adapter.definition.enabledByDefault).toBe(false);
    expect(adapter.definition.defaultPollIntervalSeconds).toBe(21_600);
    expect(adapter.definition.minimumPollIntervalSeconds).toBe(3_600);
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("attack or victim counts");
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("business risk");
    expect(adapter.maxRecordsPerWorkUnit).toBe(2_501);
    expect(adapter.normalizationVersion).toBe("first-epss-normalization-v1");
  });

  it("parses source-native model metadata without hard-coding the current EPSS model", () => {
    const current = parseFirstEpssMetadataLine("#model_version:v2026.06.15,score_date:2026-08-12T00:00:00+0000");
    expect(current.modelVersion).toBe("v2026.06.15");
    expect(current.datasetDate).toBe("2026-08-12");
    expect(current.normalizedScoreTimestamp).toBe("2026-08-12T00:00:00.000Z");

    const future = parseFirstEpssMetadataLine("#model_version:v2027.01.01,score_date:2027-01-03T13:30:00Z");
    expect(future.modelVersion).toBe("v2027.01.01");
    expect(future.datasetDate).toBe("2027-01-03");
  });

  it("validates the full gzip CSV while retaining a deterministic bounded top population", async () => {
    const rows: string[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      const cve = `CVE-2026-${10_000 + index}`;
      const epss = (0.1 + index / 10_000).toFixed(5);
      const percentile = (0.5 + index / 10_000).toFixed(5);
      rows.push(`${cve},${epss},${percentile}`);
    }
    const parsed = await parseFirstEpssArtifact({ stream: chunked(dataset(rows), 73) });
    expect(parsed.totalRows).toBe(3_000);
    expect(parsed.qualifiedRows).toBe(3_000);
    expect(parsed.selected).toHaveLength(FIRST_EPSS_CAPTURE_PROFILE.maximumRecords);
    expect(parsed.selected[0]?.cve).toBe("CVE-2026-12999");
    expect(parsed.selected.at(-1)?.cve).toBe("CVE-2026-10500");
    expect(parsed.datasetContentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.selectedPopulationSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses CVE lexical order as the deterministic final tie-breaker", async () => {
    const parsed = await parseFirstEpssArtifact({
      stream: chunked(dataset([
        "CVE-2026-10003,0.50000,0.90000",
        "CVE-2026-10001,0.50000,0.90000",
        "CVE-2026-10002,0.50000,0.90000",
      ])),
      maximumRecords: 2,
    });
    expect(parsed.selected.map((row) => row.cve)).toEqual(["CVE-2026-10001", "CVE-2026-10002"]);
  });

  it("accepts scientific notation used by live FIRST probability fields", async () => {
    const parsed = await parseFirstEpssArtifact({
      stream: chunked(dataset([
        "CVE-2023-20914,0.0006,9e-05",
        "CVE-2026-12345,1e-1,9.5E-1",
      ])),
      minimumEpss: 0,
    });

    expect(parsed.totalRows).toBe(2);
    expect(parsed.selected).toHaveLength(2);

    const liveShape = parsed.selected.find((row) => row.cve === "CVE-2023-20914");
    expect(liveShape?.epss).toBe(0.0006);
    expect(liveShape?.percentile).toBe(0.00009);

    const exponentShape = parsed.selected.find((row) => row.cve === "CVE-2026-12345");
    expect(exponentShape?.epss).toBe(0.1);
    expect(exponentShape?.percentile).toBe(0.95);
  });

  it("retains unknown additive CSV columns only as raw selected-row extras", async () => {
    const csv = gzipCsv([
      "#model_version:v2026.06.15,score_date:2026-08-12T00:00:00+0000",
      "cve,epss,percentile,future_field",
      "CVE-2026-12345,0.80000,0.99000,preserve-me",
    ]);
    const parsed = await parseFirstEpssArtifact({ stream: chunked(csv) });
    expect(parsed.selected[0]?.sourceExtras).toEqual({ future_field: "preserve-me" });
  });

  it("fails the entire snapshot on a duplicate CVE instead of silently selecting one row", async () => {
    await expect(parseFirstEpssArtifact({
      stream: chunked(dataset([
        "CVE-2026-12345,0.80000,0.99000",
        "CVE-2026-12345,0.81000,0.99100",
      ])),
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR" });
  });

  it("fails the entire snapshot on malformed probabilities and corrupted gzip", async () => {
    await expect(parseFirstEpssArtifact({
      stream: chunked(dataset(["CVE-2026-12345,1.50000,0.99000"])),
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR" });

    await expect(parseFirstEpssArtifact({
      stream: chunked(Buffer.from("not-gzip")),
    })).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });

  it("rejects a gzip artifact whose decompressed CSV exceeds the independent bound", async () => {
    await expect(parseFirstEpssArtifact({
      stream: chunked(dataset([
        "CVE-2026-12345,0.80000,0.99000",
        "CVE-2026-12346,0.70000,0.98000",
      ])),
      maxDecompressedBytes: 64,
    })).rejects.toMatchObject({ code: "PAYLOAD_LIMIT_EXCEEDED" });
  });

  it("allows a valid dataset with zero records qualifying for the capture profile", async () => {
    const parsed = await parseFirstEpssArtifact({
      stream: chunked(dataset([
        "CVE-2026-12345,0.00100,0.10000",
        "CVE-2026-12346,0.09999,0.80000",
      ])),
    });
    expect(parsed.totalRows).toBe(2);
    expect(parsed.qualifiedRows).toBe(0);
    expect(parsed.selected).toHaveLength(0);
  });

  it("normalizes a score as probability evidence without inventing risk, severity, or exploitation facts", () => {
    const drafts = normalizeFirstEpssPayload({
      kind: "EPSS_SCORE",
      cve: "CVE-2026-12345",
      epss: "0.812340000",
      percentile: "0.991230000",
      scoreDate: "2026-08-12",
      modelVersion: "v2026.06.15",
      datasetContentSha256: "a".repeat(64),
      captureProfile: {
        key: "EPSS_HIGH_SIGNAL_V1",
        minimumEpss: 0.1,
        maximumRecords: 2500,
        ordering: ["epss_desc", "percentile_desc", "cve_asc"],
      },
    });
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.recordKind).toBe("EXPLOIT_PROBABILITY_SCORE");
    expect(draft?.canonicalKey).toBe("epss:CVE-2026-12345");
    expect(draft?.entities).toEqual([{ kind: "CVE", key: "CVE-2026-12345", label: "CVE-2026-12345" }]);
    const predicates = draft?.facts.map((fact) => fact.predicate) ?? [];
    expect(predicates).toContain("epss.score");
    expect(predicates).toContain("epss.model_version");
    expect(predicates).not.toContain("epss.risk");
    expect(predicates).not.toContain("epss.severity");
    expect(predicates).not.toContain("epss.attack_count");
    expect(predicates).not.toContain("epss.active_exploitation");
  });

  it("normalizes a dataset manifest to zero canonical intelligence records", () => {
    const drafts = normalizeFirstEpssPayload({
      kind: "EPSS_DATASET_MANIFEST",
      datasetDate: "2026-08-12",
      modelVersion: "v2026.06.15",
      totalRows: 100,
      qualifiedRows: 10,
      selectedRows: 10,
      captureProfile: {
        key: "EPSS_HIGH_SIGNAL_V1",
        minimumEpss: 0.1,
        maximumRecords: 2500,
        ordering: ["epss_desc", "percentile_desc", "cve_asc"],
      },
      compressedBytes: 100,
      decompressedBytes: 1000,
      compressedArtifactSha256: "b".repeat(64),
      datasetContentSha256: "c".repeat(64),
      selectedPopulationSha256: "d".repeat(64),
      sourceHeader: "#model_version:v2026.06.15,score_date:2026-08-12T00:00:00+0000",
      http: { etag: null, lastModified: null, finalUrl: "https://epss.empiricalsecurity.com/epss_scores-2026-08-12.csv.gz", redirectChain: [] },
    });
    expect(drafts).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { admissionPolicyRegistry } from "../src/sources/admission/registry.js";
import { createSiemensProductCertAdapter, normalizeSiemensProductCertEntry } from "../src/sources/siemens-productcert.js";

const documentUrl = "https://cert-portal.siemens.com/productcert/html/ssa-26-123.html";
const hashUrl = "https://cert-portal.siemens.com/productcert/csaf/ssa-26-123.json.sha256";

const entry = {
  id: "https://cert-portal.siemens.com/productcert/csaf/ssa-26-123.json",
  title: "SSA-26-123: Fixture advisory for CVE-2026-12345",
  published: "2026-08-13T10:00:00Z",
  updated: "2026-08-13T12:30:00Z",
  summary: { content: "Fixture summary for CVE-2026-12345" },
  content: { src: documentUrl, type: "application/csaf+json" },
  link: [
    { rel: "hash", href: hashUrl, type: "text/plain" },
  ],
};

const feed = {
  feed: {
    id: "https://cert-portal.siemens.com/productcert/csaf/ssa-feed-tlp-white.json",
    title: "Siemens ProductCERT TLP:WHITE feed",
    updated: "2026-08-13T12:30:00Z",
    entry: [entry],
  },
};

function jsonFetch(payload: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Siemens ProductCERT source", () => {
  it("normalizes ROLIE publication identity and document provenance", () => {
    const canonical = normalizeSiemensProductCertEntry({ kind: "SIEMENS_PRODUCTCERT_ENTRY", source: entry })[0];
    expect(canonical?.recordKind).toBe("SECURITY_ADVISORY");
    expect(canonical?.canonicalKey).toBe("security-advisory:siemens-productcert:ssa-26-123");
    expect(canonical?.entities).toContainEqual({ kind: "CVE", key: "CVE-2026-12345", label: "CVE-2026-12345" });
    expect(canonical?.facts).toContainEqual({ predicate: "siemens_productcert.hash_reference", value: hashUrl });
    expect(canonical?.references).toEqual([documentUrl]);
  });

  it("preserves feed publication and update time separately", async () => {
    const adapter = createSiemensProductCertAdapter({ fetchImpl: jsonFetch(feed) });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(result.records).toHaveLength(2);
    expect(adapter.identifyRawRecord(result.records[0])).toBe("SSA-26-123");
    expect(adapter.extractTimes(result.records[0])).toEqual({
      publishedAt: "2026-08-13T10:00:00Z",
      effectiveAt: "2026-08-13T10:00:00Z",
      upstreamUpdatedAt: "2026-08-13T12:30:00Z",
    });
  });

  it("is idempotent for an unchanged feed snapshot", async () => {
    const adapter = createSiemensProductCertAdapter({ fetchImpl: jsonFetch(feed) });
    const first = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    const second = await adapter.fetch({ work: first.nextCheckpoint, signal: new AbortController().signal });
    expect(second.records).toEqual([]);
  });

  it("keeps the publication-only source out of measurement projection", () => {
    const policy = admissionPolicyRegistry.get("SIEMENS_PRODUCTCERT_CSAF");
    expect(policy?.collectionAllowed).toBe(true);
    expect(policy?.canonicalProjectionAllowed).toBe(true);
    expect(policy?.measurementProjectionAllowed).toBe(false);
  });
});

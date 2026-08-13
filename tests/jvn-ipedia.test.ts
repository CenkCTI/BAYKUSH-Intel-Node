import { describe, expect, it } from "vitest";
import { admissionPolicyRegistry } from "../src/sources/admission/registry.js";
import { createJvnIpediaAdapter, normalizeJvnIpediaPayload, parseJvnIpediaFeed } from "../src/sources/jvn-ipedia.js";

const entry = `
<item rdf:about="https://jvndb.jvn.jp/en/contents/2026/JVNDB-2026-000001.html">
  <title>Fixture vulnerability advisory</title>
  <link>https://jvndb.jvn.jp/en/contents/2026/JVNDB-2026-000001.html</link>
  <description>Fixture overview</description>
  <dc:publisher>Example Vendor</dc:publisher>
  <sec:identifier>JVNDB-2026-000001</sec:identifier>
  <sec:references source="CVE" id="CVE-2026-12345">https://www.cve.org/CVERecord?id=CVE-2026-12345</sec:references>
  <dcterms:issued>2026-08-13T10:00:00+09:00</dcterms:issued>
  <dcterms:modified>2026-08-13T12:30:00+09:00</dcterms:modified>
</item>`;

function feed(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:sec="http://jvn.jp/rss/mod_sec/">
${items}
</rdf:RDF>`;
}

function rdfFetch(newXml: string, updatedXml: string): typeof fetch {
  return async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = url.includes("jvndb_new.rdf") ? newXml : updatedXml;
    return new Response(body, { status: 200, headers: { "content-type": "application/rdf+xml; charset=UTF-8" } });
  };
}

describe("JVN iPedia source", () => {
  it("parses JVNRSS namespace fields without flattening source identity", () => {
    const parsed = parseJvnIpediaFeed(feed(entry));
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.identifier).toBe("JVNDB-2026-000001");
    expect(parsed[0]?.references[0]).toEqual({ source: "CVE", id: "CVE-2026-12345", url: "https://www.cve.org/CVERecord?id=CVE-2026-12345" });
  });

  it("normalizes a JVN advisory and links CVE identity", () => {
    const source = parseJvnIpediaFeed(feed(entry))[0];
    const canonical = normalizeJvnIpediaPayload({ kind: "JVN_IPEDIA_ENTRY", source })[0];
    expect(canonical?.recordKind).toBe("SECURITY_ADVISORY");
    expect(canonical?.canonicalKey).toBe("security-advisory:jvn-ipedia:jvndb-2026-000001");
    expect(canonical?.entities).toContainEqual({ kind: "CVE", key: "CVE-2026-12345", label: "CVE-2026-12345" });
  });

  it("preserves source issued and modified time as UTC instants", async () => {
    const adapter = createJvnIpediaAdapter({ fetchImpl: rdfFetch(feed(entry), feed(entry)) });
    const result = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(result.records).toHaveLength(2);
    expect(adapter.identifyRawRecord(result.records[0])).toBe("JVNDB-2026-000001");
    expect(adapter.extractTimes(result.records[0])).toEqual({
      publishedAt: "2026-08-13T01:00:00.000Z",
      effectiveAt: "2026-08-13T01:00:00.000Z",
      upstreamUpdatedAt: "2026-08-13T03:30:00.000Z",
    });
  });

  it("deduplicates the new and updated surfaces and is idempotent for an unchanged snapshot", async () => {
    const adapter = createJvnIpediaAdapter({ fetchImpl: rdfFetch(feed(entry), feed(entry)) });
    const first = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(first.records).toHaveLength(2);
    const second = await adapter.fetch({ work: first.nextCheckpoint, signal: new AbortController().signal });
    expect(second.records).toEqual([]);
  });

  it("rejects a document without the expected feed root", () => {
    expect(() => parseJvnIpediaFeed("<unexpected><item /></unexpected>")).toThrow();
  });

  it("keeps the recent feed out of measurement projection", () => {
    const policy = admissionPolicyRegistry.get("JVN_IPEDIA");
    expect(policy?.canonicalProjectionAllowed).toBe(true);
    expect(policy?.measurementProjectionAllowed).toBe(false);
  });
});

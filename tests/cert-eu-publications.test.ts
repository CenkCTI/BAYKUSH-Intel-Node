import { describe, expect, it } from "vitest";
import { admissionPolicyRegistry } from "../src/sources/admission/registry.js";
import { createCertEuPublicationAdapter, normalizeCertEuPublication, parseCertEuSecurityAdvisoryFeed } from "../src/sources/cert-eu-publications.js";

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>CERT-EU Security Advisories</title>
    <item>
      <title>Security Advisory 2026-009: Fixture issue CVE-2026-12345</title>
      <link>https://cert.europa.eu/publications/security-advisories/2026-009/</link>
      <pubDate>Thu, 23 Jul 2026 07:13:03 GMT</pubDate>
      <description>Fixture publication mentioning CVE-2026-12345.</description>
    </item>
  </channel>
</rss>`;

function feedFetch(body: string): typeof fetch {
  return async () => new Response(body, { status: 200, headers: { "content-type": "application/rss+xml" } });
}

describe("CERT-EU publication source", () => {
  it("parses stable serial identity and source time", () => {
    const publications = parseCertEuSecurityAdvisoryFeed(rss);
    expect(publications).toEqual([{
      serialNumber: "2026-009",
      title: "Security Advisory 2026-009: Fixture issue CVE-2026-12345",
      url: "https://cert.europa.eu/publications/security-advisories/2026-009/",
      publishedAt: "2026-07-23T07:13:03.000Z",
      description: "Fixture publication mentioning CVE-2026-12345.",
    }]);
  });

  it("normalizes the feed item as a CERT/CSIRT publication with CVE context", () => {
    const source = parseCertEuSecurityAdvisoryFeed(rss)[0];
    const canonical = normalizeCertEuPublication({ kind: "CERT_EU_PUBLICATION", source })[0];
    expect(canonical?.recordKind).toBe("CERT_CSIRT_PUBLICATION");
    expect(canonical?.canonicalKey).toBe("cert-publication:cert-eu:2026-009");
    expect(canonical?.entities).toContainEqual({ kind: "CVE", key: "CVE-2026-12345", label: "CVE-2026-12345" });
  });

  it("is idempotent for an unchanged feed snapshot", async () => {
    const adapter = createCertEuPublicationAdapter({ fetchImpl: feedFetch(rss) });
    const first = await adapter.fetch({ work: await adapter.plan({ checkpoint: null }), signal: new AbortController().signal });
    expect(first.records).toHaveLength(2);
    const second = await adapter.fetch({ work: first.nextCheckpoint, signal: new AbortController().signal });
    expect(second.records).toEqual([]);
  });

  it("keeps the recent feed out of measurement projection", () => {
    const policy = admissionPolicyRegistry.get("CERT_EU_SECURITY_ADVISORY");
    expect(policy?.canonicalProjectionAllowed).toBe(true);
    expect(policy?.measurementProjectionAllowed).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { fetchBoundedArtifact } from "../src/http/source-artifact.js";

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const allowedEndpoints = [
  { hostname: "epss.empiricalsecurity.com", path: /^\/epss_scores-current\.csv\.gz$/ },
  { hostname: "epss.empiricalsecurity.com", path: /^\/epss_scores-\d{4}-\d{2}-\d{2}\.csv\.gz$/ },
];

describe("bounded source artifact transport", () => {
  it("follows only allowlisted HTTPS redirects and hashes the complete compressed body", async () => {
    const requests: string[] = [];
    const body = Buffer.from("gzip-like-fixture");
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("epss_scores-current.csv.gz")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://epss.empiricalsecurity.com/epss_scores-2026-08-12.csv.gz" },
        });
      }
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/gzip", etag: "fixture-etag" },
      });
    };

    const result = await fetchBoundedArtifact({
      url: new URL("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"),
      allowedEndpoints,
      maxRedirects: 3,
      maxCompressedBytes: 1024,
      timeoutMs: 5_000,
      acceptedContentTypes: ["application/gzip"],
      fetchImpl,
      consume: async ({ stream }) => (await collect(stream)).toString("utf8"),
    });

    expect(requests).toHaveLength(2);
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe("https://epss.empiricalsecurity.com/epss_scores-2026-08-12.csv.gz");
    expect(result.redirectChain).toEqual(["https://epss.empiricalsecurity.com/epss_scores-2026-08-12.csv.gz"]);
    expect(result.compressedBytes).toBe(body.length);
    expect(result.compressedSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value).toBe("gzip-like-fixture");
  });

  it("strips sensitive headers when an explicitly allowlisted redirect crosses hosts", async () => {
    const observedHeaders: Headers[] = [];
    const crossHostRules = [
      { hostname: "source.example", path: /^\/current$/ },
      { hostname: "cdn.example", path: /^\/dated$/ },
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      observedHeaders.push(new Headers(init?.headers));
      if (new URL(String(input)).hostname === "source.example") {
        return new Response(null, { status: 302, headers: { location: "https://cdn.example/dated" } });
      }
      return new Response(Buffer.from("artifact"), { status: 200, headers: { "content-type": "application/octet-stream" } });
    };

    await fetchBoundedArtifact({
      url: new URL("https://source.example/current"),
      allowedEndpoints: crossHostRules,
      maxCompressedBytes: 1024,
      timeoutMs: 5_000,
      headers: {
        Authorization: "Bearer secret",
        apiKey: "api-secret",
        "Auth-Key": "auth-secret",
        "x-trace-id": "keep-me",
      },
      fetchImpl,
      consume: async ({ stream }) => collect(stream),
    });

    expect(observedHeaders).toHaveLength(2);
    expect(observedHeaders[0]?.get("authorization")).toBe("Bearer secret");
    expect(observedHeaders[1]?.get("authorization")).toBeNull();
    expect(observedHeaders[1]?.get("apikey")).toBeNull();
    expect(observedHeaders[1]?.get("auth-key")).toBeNull();
    expect(observedHeaders[1]?.get("x-trace-id")).toBe("keep-me");
  });

  it("rejects a redirect outside the explicit provider allowlist", async () => {
    await expect(fetchBoundedArtifact({
      url: new URL("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"),
      allowedEndpoints,
      maxCompressedBytes: 1024,
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/epss_scores-2026-08-12.csv.gz" },
      }),
      consume: async ({ stream }) => collect(stream),
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR" });
  });

  it("rejects HTTPS downgrade and oversized compressed bodies", async () => {
    await expect(fetchBoundedArtifact({
      url: new URL("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"),
      allowedEndpoints,
      maxCompressedBytes: 1024,
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "http://epss.empiricalsecurity.com/epss_scores-2026-08-12.csv.gz" },
      }),
      consume: async ({ stream }) => collect(stream),
    })).rejects.toMatchObject({ code: "SCHEMA_ERROR" });

    await expect(fetchBoundedArtifact({
      url: new URL("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"),
      allowedEndpoints,
      maxCompressedBytes: 4,
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(Buffer.from("too-large"), {
        status: 200,
        headers: { "content-type": "application/gzip" },
      }),
      consume: async ({ stream }) => collect(stream),
    })).rejects.toMatchObject({ code: "PAYLOAD_LIMIT_EXCEEDED" });
  });

  it("supports conditional 304 without invoking the artifact consumer", async () => {
    let consumed = false;
    const result = await fetchBoundedArtifact({
      url: new URL("https://epss.empiricalsecurity.com/epss_scores-current.csv.gz"),
      allowedEndpoints,
      maxCompressedBytes: 1024,
      timeoutMs: 5_000,
      fetchImpl: async () => new Response(null, { status: 304, headers: { etag: "same" } }),
      consume: async ({ stream }) => {
        consumed = true;
        return collect(stream);
      },
    });
    expect(result.status).toBe(304);
    expect(result.value).toBeNull();
    expect(consumed).toBe(false);
  });
});

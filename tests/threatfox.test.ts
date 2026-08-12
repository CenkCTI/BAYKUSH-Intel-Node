import { describe, expect, it } from "vitest";
import {
  createThreatFoxAdapter,
  normalizeThreatFoxIndicator,
  normalizeThreatFoxPayload,
  parseThreatFoxTimestamp,
  threatFoxRecoveryWindow,
} from "../src/sources/threatfox.js";
import { CollectionFailure } from "../src/runtime/failure.js";

const AUTH_KEY = "unit-test-threatfox-key";
const NOW = Date.parse("2026-08-12T10:00:00.000Z");

type IocOverrides = Record<string, unknown>;

function ioc(id: string, value: string, iocType: string, overrides: IocOverrides = {}) {
  return {
    id,
    ioc: value,
    threat_type: "botnet_cc",
    threat_type_desc: "Botnet command and control infrastructure",
    ioc_type: iocType,
    ioc_type_desc: `fixture ${iocType}`,
    malware: "win.cobalt_strike",
    malware_printable: "Cobalt Strike",
    malware_alias: "BEACON,CobaltStrike",
    malware_malpedia: "https://malpedia.caad.fkie.fraunhofer.de/details/win.cobalt_strike",
    confidence_level: 75,
    first_seen: "2026-08-12 08:00:00 UTC",
    last_seen: null,
    reporter: "abuse_ch",
    reference: "https://example.test/report",
    tags: ["fixture"],
    ...overrides,
  };
}

function response(data: readonly unknown[], queryStatus = "ok"): Response {
  return new Response(JSON.stringify({ query_status: queryStatus, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function fetchOnce(input: {
  data: readonly unknown[];
  checkpoint?: unknown | null;
  now?: number;
  authKey?: string;
  queryStatus?: string;
}) {
  let observedUrl = "";
  let observedMethod: string | undefined;
  let observedBody = "";
  let observedAuth: string | null = null;
  let observedContentType: string | null = null;
  const fakeFetch = (async (request: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(request);
    observedMethod = init?.method;
    observedBody = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    observedAuth = headers.get("Auth-Key");
    observedContentType = headers.get("content-type");
    return response(input.data, input.queryStatus ?? "ok");
  }) as typeof fetch;

  const adapter = createThreatFoxAdapter({
    authKey: input.authKey ?? AUTH_KEY,
    fetchImpl: fakeFetch,
    now: () => input.now ?? NOW,
  });
  const work = await adapter.plan({ checkpoint: input.checkpoint ?? null });
  const result = await adapter.fetch({ work, signal: new AbortController().signal });
  return { adapter, work, result, observedUrl, observedMethod, observedBody, observedAuth, observedContentType };
}

describe("ThreatFox production adapter", () => {
  it("declares report-only source semantics, required auth, fair-use restrictions, and remains disabled", () => {
    const adapter = createThreatFoxAdapter({ authKey: AUTH_KEY });
    expect(adapter.definition.sourceKey).toBe("THREATFOX");
    expect(adapter.definition.sourceClass).toBe("IOC_SHARING");
    expect(adapter.definition.observationBasis).toBe("REPORTED");
    expect(adapter.definition.collectionMode).toBe("SNAPSHOT");
    expect(adapter.definition.recoveryStrategy).toBe("SNAPSHOT_RECONSTRUCTION");
    expect(adapter.definition.authRequirement).toBe("REQUIRED");
    expect(adapter.definition.requiresAuth).toBe(true);
    expect(adapter.definition.credentialKind).toBe("THREATFOX_AUTH_KEY");
    expect(adapter.definition.defaultPollIntervalSeconds).toBe(3_600);
    expect(adapter.definition.minimumPollIntervalSeconds).toBe(3_600);
    expect(adapter.definition.commercialUseStatus).toBe("RESTRICTED");
    expect(adapter.definition.redistributionStatus).toBe("UNKNOWN");
    expect(adapter.definition.enabledByDefault).toBe(false);
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("attack or victim counts");
    expect(adapter.definition.semanticBoundary.doesNotRepresent).toContain("attacker identity or origin");
    expect(adapter.maxRecordsPerWorkUnit).toBe(10_000);
  });

  it("plans the bounded 1-7 day recovery window and marks unrecoverable gaps", () => {
    expect(threatFoxRecoveryWindow(NOW, null)).toEqual({ days: 7, recoveryGapExceeded: false });
    expect(threatFoxRecoveryWindow(NOW, new Date(NOW - 60 * 60 * 1_000).toISOString()))
      .toEqual({ days: 1, recoveryGapExceeded: false });
    expect(threatFoxRecoveryWindow(NOW, new Date(NOW - 30 * 60 * 60 * 1_000).toISOString()))
      .toEqual({ days: 2, recoveryGapExceeded: false });
    expect(threatFoxRecoveryWindow(NOW, new Date(NOW - 4 * 86_400_000).toISOString()))
      .toEqual({ days: 4, recoveryGapExceeded: false });
    expect(threatFoxRecoveryWindow(NOW, new Date(NOW - 9 * 86_400_000).toISOString()))
      .toEqual({ days: 7, recoveryGapExceeded: true });
  });

  it("uses the exact authenticated POST endpoint and never puts the secret in URL or body", async () => {
    const run = await fetchOnce({ data: [ioc("1", "example.test", "domain")] });
    expect(run.observedUrl).toBe("https://threatfox-api.abuse.ch/api/v1/");
    expect(run.observedMethod).toBe("POST");
    expect(run.observedAuth).toBe(AUTH_KEY);
    expect(run.observedContentType).toBe("application/json");
    expect(JSON.parse(run.observedBody)).toEqual({ days: 7, query: "get_iocs" });
    expect(run.observedUrl).not.toContain(AUTH_KEY);
    expect(run.observedBody).not.toContain(AUTH_KEY);
  });

  it("fails with controlled authentication error when a key is unavailable", async () => {
    const adapter = createThreatFoxAdapter({ authKey: "", now: () => NOW });
    const work = await adapter.plan({ checkpoint: null });
    await expect(adapter.fetch({ work, signal: new AbortController().signal })).rejects.toMatchObject({
      code: "AUTHENTICATION_ERROR",
      retryable: false,
    });
  });

  it("redacts the Auth-Key if a provider authentication diagnostic echoes it", async () => {
    const secret = "threatfox-secret-do-not-log";
    const fakeFetch = (async () => new Response("unauthorized", {
      status: 401,
      headers: { message: `invalid Auth-Key ${secret}` },
    })) as typeof fetch;
    const adapter = createThreatFoxAdapter({ authKey: secret, fetchImpl: fakeFetch, now: () => NOW });
    const work = await adapter.plan({ checkpoint: null });
    try {
      await adapter.fetch({ work, signal: new AbortController().signal });
      throw new Error("expected authentication failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CollectionFailure);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).toContain("[REDACTED]");
    }
  });

  it("preserves additive source fields in raw IOC evidence and emits a non-canonical query manifest", async () => {
    const run = await fetchOnce({
      data: [ioc("10", "example.test", "domain", { future_field: { nested: "preserve-me" } })],
    });
    expect(run.result.records).toHaveLength(2);
    const manifest = run.adapter.rawPayload(run.result.records[0]);
    const rawIoc = run.adapter.rawPayload(run.result.records[1]) as { source?: Record<string, unknown> };
    expect(manifest).toMatchObject({
      kind: "THREATFOX_QUERY_MANIFEST",
      query: "get_iocs",
      days: 7,
      queryStatus: "ok",
      recordCount: 1,
      recoveryGapExceeded: false,
    });
    expect(normalizeThreatFoxPayload(manifest)).toEqual([]);
    expect(rawIoc.source?.future_field).toEqual({ nested: "preserve-me" });
  });

  it("normalizes supported indicator families conservatively", () => {
    expect(normalizeThreatFoxIndicator("domain", "Example.COM.")).toMatchObject({
      status: "NORMALIZED",
      entity: { kind: "DOMAIN", key: "example.com" },
    });
    expect(normalizeThreatFoxIndicator("url", "https://Example.com/Login?Token=ABC")).toMatchObject({
      status: "NORMALIZED",
      entity: { kind: "URL", key: "https://example.com/Login?Token=ABC" },
    });
    expect(normalizeThreatFoxIndicator("ip:port", "192.0.2.10:8443")).toEqual({
      status: "NORMALIZED",
      entity: { kind: "IP", key: "192.0.2.10", label: "192.0.2.10" },
      port: 8443,
    });
    expect(normalizeThreatFoxIndicator("md5_hash", "A".repeat(32))).toMatchObject({
      status: "NORMALIZED",
      entity: { kind: "HASH", key: `md5:${"a".repeat(32)}` },
    });
    expect(normalizeThreatFoxIndicator("sha1_hash", "B".repeat(40))).toMatchObject({
      status: "NORMALIZED",
      entity: { kind: "HASH", key: `sha1:${"b".repeat(40)}` },
    });
    expect(normalizeThreatFoxIndicator("sha256_hash", "C".repeat(64))).toMatchObject({
      status: "NORMALIZED",
      entity: { kind: "HASH", key: `sha256:${"c".repeat(64)}` },
    });
  });

  it("keeps URL path and query case significant", () => {
    const upper = normalizeThreatFoxIndicator("url", "https://EXAMPLE.com/Login?Token=ABC");
    const lower = normalizeThreatFoxIndicator("url", "https://example.com/login?Token=abc");
    expect(upper.entity?.key).toBe("https://example.com/Login?Token=ABC");
    expect(lower.entity?.key).toBe("https://example.com/login?Token=abc");
    expect(upper.entity?.key).not.toBe(lower.entity?.key);
  });

  it("retains an IOC report when indicator normalization is unknown or source-invalid", () => {
    const unknown = normalizeThreatFoxPayload({
      kind: "THREATFOX_IOC",
      source: ioc("20", "future-fingerprint", "future_type"),
    });
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.recordKind).toBe("IOC_REPORT");
    expect(unknown[0]?.entities.filter((entity) => entity.kind !== "MALWARE")).toHaveLength(0);
    expect(unknown[0]?.facts).toContainEqual({
      predicate: "baykush.indicator_normalization_status",
      value: "UNMAPPED",
    });

    const invalid = normalizeThreatFoxPayload({
      kind: "THREATFOX_IOC",
      source: ioc("21", "999.999.999.999:443", "ip:port"),
    });
    expect(invalid[0]?.recordKind).toBe("IOC_REPORT");
    expect(invalid[0]?.facts).toContainEqual({
      predicate: "baykush.indicator_normalization_status",
      value: "INVALID_SOURCE_VALUE",
    });
  });

  it("keeps ThreatFox confidence source-attributed and does not manufacture analytic conclusions", () => {
    const drafts = normalizeThreatFoxPayload({
      kind: "THREATFOX_IOC",
      source: ioc("30", "192.0.2.10:443", "ip:port", {
        confidence_level: 100,
        is_compromised: "1",
      }),
    });
    const draft = drafts[0];
    expect(draft?.canonicalKey).toBe("threatfox:ioc:30");
    expect(draft?.recordKind).toBe("IOC_REPORT");
    expect(draft?.entities).toContainEqual({ kind: "IP", key: "192.0.2.10", label: "192.0.2.10" });
    expect(draft?.facts).toContainEqual({ predicate: "threatfox.port", value: 443 });
    expect(draft?.facts).toContainEqual({ predicate: "threatfox.confidence_level", value: 100 });
    expect(draft?.facts).toContainEqual({ predicate: "threatfox.is_compromised", value: true });
    const predicates = new Set(draft?.facts.map((fact) => fact.predicate));
    for (const unsafe of [
      "attack.count",
      "attack.confirmed",
      "risk",
      "severity",
      "priority",
      "threat_level",
      "active_exploitation",
      "attacker_country",
      "baykush.global_priority",
      "independent_confirmation",
    ]) expect(predicates.has(unsafe)).toBe(false);
  });

  it("maps source time semantics without pretending first_seen is publication or last_seen is an update timestamp", async () => {
    const run = await fetchOnce({
      data: [ioc("40", "example.test", "domain", { last_seen: "2026-08-12 09:00:00 UTC" })],
    });
    const times = run.adapter.extractTimes(run.result.records[1]);
    expect(times).toEqual({
      publishedAt: null,
      effectiveAt: "2026-08-12T08:00:00.000Z",
      upstreamUpdatedAt: null,
    });
    expect(parseThreatFoxTimestamp("2026-08-12 09:00:00 UTC")).toBe("2026-08-12T09:00:00.000Z");
  });

  it("produces an order-independent snapshot fingerprint while preserving response-byte provenance", async () => {
    const a = ioc("50", "a.example", "domain");
    const b = ioc("51", "b.example", "domain");
    const first = await fetchOnce({ data: [a, b] });
    const firstManifest = first.adapter.rawPayload(first.result.records[0]) as Record<string, unknown>;
    const checkpoint = first.result.nextCheckpoint;

    const second = await fetchOnce({ data: [b, a], checkpoint, now: NOW + 60 * 60 * 1_000 });
    const secondManifest = second.adapter.rawPayload(second.result.records[0]) as Record<string, unknown>;
    expect(secondManifest.snapshotFingerprint).toBe(firstManifest.snapshotFingerprint);
    expect(secondManifest.responseSha256).not.toBe(firstManifest.responseSha256);
  });

  it("returns zero records for the exact same snapshot under the same query/recovery context", async () => {
    const data = [ioc("60", "same.example", "domain")];
    const bootstrap = await fetchOnce({ data });
    const firstLive = await fetchOnce({ data, checkpoint: bootstrap.result.nextCheckpoint, now: NOW + 60 * 60 * 1_000 });
    expect(firstLive.result.records.length).toBeGreaterThan(0);
    const exactSame = await fetchOnce({ data, checkpoint: firstLive.result.nextCheckpoint, now: NOW + 2 * 60 * 60 * 1_000 });
    expect(exactSame.result.records).toEqual([]);
  });

  it("persists a manifest when recovery context changes even if provider data is unchanged", async () => {
    const data = [ioc("61", "gap.example", "domain")];
    const first = await fetchOnce({ data });
    const firstCheckpoint = first.result.nextCheckpoint as Record<string, unknown>;
    const oldCheckpoint = {
      ...firstCheckpoint,
      lastSuccessfulCollectionAt: new Date(NOW - 9 * 86_400_000).toISOString(),
      recoveryWindowDays: 1,
      recoveryGapExceeded: false,
    };
    const recovered = await fetchOnce({ data, checkpoint: oldCheckpoint, now: NOW });
    expect(recovered.result.records.length).toBeGreaterThan(0);
    expect(recovered.adapter.rawPayload(recovered.result.records[0])).toMatchObject({
      kind: "THREATFOX_QUERY_MANIFEST",
      days: 7,
      recoveryGapExceeded: true,
    });
  });

  it("rejects duplicate ThreatFox source IDs as a retryable snapshot anomaly", async () => {
    const duplicate = ioc("70", "dup.example", "domain");
    await expect(fetchOnce({ data: [duplicate, duplicate] })).rejects.toMatchObject({
      code: "SOURCE_SNAPSHOT_CHANGED",
      retryable: true,
    });
  });

  it("fails closed on an unexpected provider query status", async () => {
    await expect(fetchOnce({ data: [], queryStatus: "maintenance" })).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
    });
  });

  it("enforces the independent bounded response size", async () => {
    let called = 0;
    const fakeFetch = (async () => {
      called += 1;
      return response([ioc("80", "large.example", "domain")]);
    }) as typeof fetch;
    const adapter = createThreatFoxAdapter({ authKey: AUTH_KEY, fetchImpl: fakeFetch, now: () => NOW, maxResponseBytes: 32 });
    const work = await adapter.plan({ checkpoint: null });
    await expect(adapter.fetch({ work, signal: new AbortController().signal })).rejects.toMatchObject({
      code: "PAYLOAD_LIMIT_EXCEEDED",
      retryable: false,
    });
    expect(called).toBe(1);
  });
});

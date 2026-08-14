import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { createApiServer as CreateApiServer } from "../src/api/server.js";
import type { publicSourceKeys as PublicSourceKeys } from "../src/api/read-api.js";

const TOKEN = "node5-read-api-test-token-at-least-32-bytes";
const servers: Server[] = [];
let createApiServer: typeof CreateApiServer;
let publicSourceKeys: typeof PublicSourceKeys;

beforeAll(async () => {
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/unused";
  ({ createApiServer } = await import("../src/api/server.js"));
  ({ publicSourceKeys } = await import("../src/api/read-api.js"));
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function request(path: string) {
  const server = createApiServer({ apiToken: TOKEN });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  return {
    response,
    body: await response.json() as {
      apiVersion?: string;
      data?: Array<{ measurementKey?: string }>;
      meta?: { count?: number };
    },
  };
}

const newMeasurementKeys = [
  "ioc.feodo_tracker.new_records_observed",
  "ioc.sslbl.certificate_listings_observed",
  "vulnerability.github_advisory.publications",
  "vulnerability.github_advisory.updates_observed",
  "vulnerability.cisa_ics.advisory_publications",
  "vulnerability.cisa_ics.advisory_updates_observed",
] as const;

describe("NODE-5 coverage-aware read API exposure", () => {
  it("exposes all admitted production sources while keeping synthetic and blocked sources private", () => {
    expect(publicSourceKeys).toEqual([
      "CISA_KEV",
      "NVD_CVE",
      "FIRST_EPSS",
      "THREATFOX",
      "MALWAREBAZAAR",
      "FEODO_TRACKER",
      "SSLBL_CERTIFICATE",
      "GITHUB_ADVISORY_REVIEWED",
      "MITRE_ATTACK_ENTERPRISE",
      "JVN_IPEDIA",
      "CISA_ICS_CSAF",
      "CERT_EU_SECURITY_ADVISORY",
      "SIEMENS_PRODUCTCERT_CSAF",
    ]);
    expect(publicSourceKeys).not.toContain("TEST_SYNTHETIC");
    expect(publicSourceKeys).not.toContain("URLHAUS");
  });

  it("publishes every NODE-5K measurement contract through the authenticated catalog", async () => {
    const result = await request("/v1/techint/measurement-catalog");
    expect(result.response.status).toBe(200);
    expect(result.body.apiVersion).toBe("v1");
    const keys = new Set((result.body.data ?? []).map((entry) => entry.measurementKey));
    for (const measurementKey of newMeasurementKeys) {
      expect(keys.has(measurementKey), measurementKey).toBe(true);
    }
    expect(result.body.meta?.count).toBe(result.body.data?.length);
  });

  it("does not manufacture measurements for NODE-5 sources whose policy forbids projection", async () => {
    const result = await request("/v1/techint/measurement-catalog");
    const keys = (result.body.data ?? []).map((entry) => entry.measurementKey ?? "");
    expect(keys.some((key) => key.includes("mitre_attack"))).toBe(false);
    expect(keys.some((key) => key.includes("jvn"))).toBe(false);
    expect(keys.some((key) => key.includes("cert_eu"))).toBe(false);
    expect(keys.some((key) => key.includes("siemens"))).toBe(false);
  });
});

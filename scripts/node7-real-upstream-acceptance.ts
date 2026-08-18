import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CISA_KEV_PRIMARY_URL,
  createCisaKevAdapter,
  normalizeCisaKevEntry,
  validateCisaKevCatalog,
} from "../src/sources/cisa-kev.js";
import {
  NVD_CVE_API_URL,
  createNvdCveAdapter,
  normalizeNvdCve,
  nvdCveResponseSchema,
} from "../src/sources/nvd-cve.js";

const USER_AGENT = "BAYKUSH-NODE7-Acceptance/1.0 (+https://github.com/CenkCTI/BAYKUSH-Intel-Node)";

async function fetchJson(url: URL, timeoutMs = 30_000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.hostname}`);
    return await response.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchNvdCve(cveId: string): Promise<unknown | null> {
  const url = new URL(NVD_CVE_API_URL.toString());
  url.searchParams.set("cveId", cveId);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const payload = nvdCveResponseSchema.parse(await fetchJson(url));
      const item = payload.vulnerabilities.find((entry) => entry.cve.id === cveId)?.cve;
      if (item) return item;
    } catch (error) {
      if (attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  }
  return null;
}

async function main(): Promise<void> {
  const cisaPayload = await fetchJson(CISA_KEV_PRIMARY_URL);
  const catalog = validateCisaKevCatalog(cisaPayload);
  const candidates = [...catalog.vulnerabilities]
    .sort((left, right) => right.dateAdded.localeCompare(left.dateAdded))
    .slice(0, 25);

  let selected: (typeof candidates)[number] | null = null;
  let nvdRecord: unknown | null = null;
  for (const candidate of candidates) {
    nvdRecord = await fetchNvdCve(candidate.cveID);
    if (nvdRecord) {
      selected = candidate;
      break;
    }
  }
  assert.ok(selected, "No recent CISA KEV entry could be resolved through the live NVD CVE API");
  assert.ok(nvdRecord, "NVD record missing for selected CISA KEV entry");

  const cisaCanonical = normalizeCisaKevEntry(selected);
  const nvdCanonical = normalizeNvdCve(nvdRecord);
  const cisaCve = cisaCanonical.entities.find((entity) => entity.kind === "CVE");
  const nvdCve = nvdCanonical.entities.find((entity) => entity.kind === "CVE");
  assert.ok(cisaCve && nvdCve, "Both live sources must normalize an exact CVE entity");
  assert.equal(cisaCve.key, nvdCve.key, "Live sources must overlap on the exact canonical CVE key");
  assert.equal(cisaCanonical.canonicalKey, nvdCanonical.canonicalKey, "Canonical CVE record keys must match");

  const cisaDefinition = createCisaKevAdapter().definition;
  const nvdDefinition = createNvdCveAdapter().definition;
  assert.notEqual(cisaDefinition.sourceKey, nvdDefinition.sourceKey);
  assert.notEqual(cisaDefinition.upstreamOriginKey, nvdDefinition.upstreamOriginKey);
  assert.notEqual(cisaDefinition.sourceClass, nvdDefinition.sourceClass);

  const evidence = {
    schemaVersion: "NODE7_REAL_UPSTREAM_OVERLAP_V1",
    accepted: true,
    observedAt: new Date().toISOString(),
    subject: { entityType: "CVE", entityKey: cisaCve.key, canonicalKey: cisaCanonical.canonicalKey },
    sources: [
      {
        sourceKey: cisaDefinition.sourceKey,
        upstreamOriginKey: cisaDefinition.upstreamOriginKey,
        sourceClass: cisaDefinition.sourceClass,
        observationBasis: cisaDefinition.observationBasis,
        officialUrl: CISA_KEV_PRIMARY_URL.toString(),
        sourceRecordId: selected.cveID,
        effectiveDate: selected.dateAdded,
      },
      {
        sourceKey: nvdDefinition.sourceKey,
        upstreamOriginKey: nvdDefinition.upstreamOriginKey,
        sourceClass: nvdDefinition.sourceClass,
        observationBasis: nvdDefinition.observationBasis,
        officialUrl: `${NVD_CVE_API_URL.toString()}?cveId=${encodeURIComponent(selected.cveID)}`,
        sourceRecordId: selected.cveID,
        publishedAt: (nvdRecord as { published?: string }).published ?? null,
        lastModifiedAt: (nvdRecord as { lastModified?: string }).lastModified ?? null,
      },
    ],
    assertions: {
      exactCanonicalEntityOverlap: true,
      distinctSourceDefinitions: true,
      distinctUpstreamOrigins: true,
      distinctSourceClasses: true,
      temporalConcurrencyClaimed: false,
      attributionClaimed: false,
      attackClaimed: false,
    },
    note: "This acceptance proves real-source exact canonical overlap. Temporal convergence classification is tested separately in the deterministic PostgreSQL acceptance because the two upstream publication/effective timestamps have different source semantics.",
  };

  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  process.stdout.write(serialized);
  const outputPath = process.env.NODE7_REAL_ACCEPTANCE_OUTPUT?.trim();
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, serialized, "utf8");
  }
}

await main();

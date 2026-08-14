import { canonicalEvidenceDraftSchema } from "../src/contracts/canonical.js";
import { adapterRegistry } from "../src/sources/node5-runtime-registry.js";

const SOURCE_KEYS = [
  "FEODO_TRACKER",
  "SSLBL_CERTIFICATE",
  "GITHUB_ADVISORY_REVIEWED",
  "MITRE_ATTACK_ENTERPRISE",
  "JVN_IPEDIA",
  "CISA_ICS_CSAF",
  "CERT_EU_SECURITY_ADVISORY",
  "SIEMENS_PRODUCTCERT_CSAF",
] as const;

const ALLOW_EMPTY = new Set<string>(["FEODO_TRACKER"]);
const FETCH_TIMEOUT_MS = 45_000;
const SAMPLE_RECORDS_PER_WORK = 3;
const MAX_WORK_UNITS = 3;

interface SourceResult {
  sourceKey: string;
  status: "PASS" | "EMPTY_PASS" | "FAIL";
  fetchedRecords: number;
  normalizedDrafts: number;
  recordKinds: string[];
  workUnits: number;
  elapsedMs: number;
  error?: string;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^\s]+/g, "[url-redacted]").slice(0, 500);
}

async function smokeSource(sourceKey: string): Promise<SourceResult> {
  const startedAt = Date.now();
  const adapter = adapterRegistry.get(sourceKey);
  if (!adapter) {
    return { sourceKey, status: "FAIL", fetchedRecords: 0, normalizedDrafts: 0, recordKinds: [], workUnits: 0, elapsedMs: Date.now() - startedAt, error: "adapter not registered" };
  }

  try {
    if (adapter.definition.enabledByDefault) throw new Error("NODE-5 source must remain disabled by default before explicit admission/enablement");

    let work = adapter.workDescriptorSchema.parse(await adapter.plan({ checkpoint: null }));
    let fetchedRecords = 0;
    let normalizedDrafts = 0;
    let workUnits = 0;
    let observedAnyRecord = false;
    const recordKinds = new Set<string>();
    const identities = new Set<string>();

    while (workUnits < MAX_WORK_UNITS) {
      workUnits += 1;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let result;
      try {
        result = await adapter.fetch({ work, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!Array.isArray(result.records)) throw new Error("fetch did not return a records array");
      const declaredBound = adapter.maxRecordsPerWorkUnit ?? 10_000;
      if (result.records.length > declaredBound) throw new Error(`provider result exceeded adapter bound (${result.records.length} > ${declaredBound})`);
      adapter.checkpointSchema.parse(result.nextCheckpoint);
      const parsedNextWork = result.nextWork === null ? null : adapter.workDescriptorSchema.parse(result.nextWork);
      if (result.complete && parsedNextWork !== null) throw new Error("complete result unexpectedly returned nextWork");
      if (!result.complete && parsedNextWork === null) throw new Error("incomplete result omitted nextWork");

      fetchedRecords += result.records.length;
      if (result.records.length > 0) observedAnyRecord = true;

      for (const record of result.records.slice(0, SAMPLE_RECORDS_PER_WORK)) {
        const identity = adapter.identifyRawRecord(record);
        if (!identity.trim()) throw new Error("empty source record identity");
        if (identities.has(identity)) throw new Error("duplicate source identity inside sampled provider response");
        identities.add(identity);

        const times = adapter.extractTimes(record);
        for (const value of [times.publishedAt, times.effectiveAt, times.upstreamUpdatedAt]) {
          if (value !== null && Number.isNaN(Date.parse(value))) throw new Error("adapter emitted an invalid source timestamp");
        }

        const reference = adapter.sourceReference(record);
        if (reference !== null && !reference.startsWith("https://")) throw new Error("source reference is not HTTPS");

        const rawPayload = adapter.rawPayload(record);
        const encoded = JSON.stringify(rawPayload);
        if (encoded === undefined) throw new Error("raw payload is not JSON serializable");
        const rawBytes = Buffer.byteLength(encoded, "utf8");
        const rawBound = adapter.maxRawRecordBytes ?? 8 * 1024 * 1024;
        if (rawBytes > rawBound) throw new Error(`sample raw record exceeded adapter raw bound (${rawBytes} > ${rawBound})`);

        const drafts = adapter.normalize(rawPayload);
        for (const draft of drafts) {
          const parsed = canonicalEvidenceDraftSchema.parse(draft);
          normalizedDrafts += 1;
          recordKinds.add(parsed.recordKind);
        }
      }

      if (normalizedDrafts > 0) break;
      if (result.complete) break;
      work = parsedNextWork as NonNullable<typeof parsedNextWork>;
    }

    if (normalizedDrafts === 0) {
      if (!observedAnyRecord && ALLOW_EMPTY.has(sourceKey)) {
        return { sourceKey, status: "EMPTY_PASS", fetchedRecords, normalizedDrafts: 0, recordKinds: [], workUnits, elapsedMs: Date.now() - startedAt };
      }
      throw new Error(observedAnyRecord
        ? `bounded smoke observed only non-canonical control records across ${workUnits} work unit(s)`
        : "provider returned zero records where this smoke expects a non-empty current surface");
    }

    return {
      sourceKey,
      status: "PASS",
      fetchedRecords,
      normalizedDrafts,
      recordKinds: [...recordKinds].sort(),
      workUnits,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      sourceKey,
      status: "FAIL",
      fetchedRecords: 0,
      normalizedDrafts: 0,
      recordKinds: [],
      workUnits: 0,
      elapsedMs: Date.now() - startedAt,
      error: safeMessage(error),
    };
  }
}

const results: SourceResult[] = [];
for (const sourceKey of SOURCE_KEYS) {
  const result = await smokeSource(sourceKey);
  results.push(result);
  const suffix = result.error ? ` error=${result.error}` : "";
  console.log(`${result.status} ${result.sourceKey} fetched=${result.fetchedRecords} canonical=${result.normalizedDrafts} kinds=${result.recordKinds.join(",") || "none"} workUnits=${result.workUnits} elapsedMs=${result.elapsedMs}${suffix}`);
}

const failed = results.filter((result) => result.status === "FAIL");
console.log(`NODE5_LIVE_PROVIDER_SMOKE sources=${results.length} passed=${results.length - failed.length} failed=${failed.length}`);
if (failed.length > 0) process.exitCode = 1;

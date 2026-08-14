import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.js";
import { pool } from "../src/db/pool.js";
import { aggregationTick } from "../src/measurement/aggregation/engine.js";
import { discoverProjectionJobs, projectionTick } from "../src/measurement/projection/runtime.js";
import { syncMeasurementRegistry } from "../src/measurement/registry.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { adapterRegistry } from "../src/sources/node5-runtime-registry.js";

const TARGETS = ["FEODO_TRACKER", "GITHUB_ADVISORY_REVIEWED", "CISA_ICS_CSAF"] as const;
const API_TOKEN = "node5-premerge-api-token-0123456789abcdef";
const GITHUB_PUBLICATION = "vulnerability.github_advisory.publications";
const CISA_PUBLICATION = "vulnerability.cisa_ics.advisory_publications";
const FEODO_LIVE = "ioc.feodo_tracker.new_records_observed";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function latestRunState(sourceKey: string): Promise<string | null> {
  const result = await pool.query<{ state: string }>(
    `SELECT r.state
     FROM collection_runs r
     JOIN source_definitions d ON d.id=r.source_definition_id
     WHERE d.source_key=$1
     ORDER BY r.created_at DESC
     LIMIT 1`,
    [sourceKey],
  );
  return result.rows[0]?.state ?? null;
}

async function drainSourceRun(sourceKey: string, maxTicks: number): Promise<void> {
  for (let index = 0; index < maxTicks; index += 1) {
    const state = await latestRunState(sourceKey);
    if (state === "SUCCEEDED") return;
    if (state === "FAILED") throw new Error(`${sourceKey} collection run failed`);
    const worked = await workerTick(`node5-premerge-worker-${sourceKey.toLowerCase()}`);
    if (!worked) throw new Error(`${sourceKey} had no claimable worker tick`);
  }
  throw new Error(`${sourceKey} did not complete within ${maxTicks} bounded worker ticks`);
}

async function rawCount(sourceKey: string, excludeControl = false): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM raw_source_records raw
     JOIN source_definitions d ON d.id=raw.source_definition_id
     WHERE d.source_key=$1
       AND ($2::boolean=false OR raw.source_record_id NOT LIKE '__%manifest%__')`,
    [sourceKey, excludeControl],
  );
  return result.rows[0]?.count ?? 0;
}

async function canonicalCount(sourceKey: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM canonical_evidence_records canonical
     JOIN source_definitions d ON d.id=canonical.source_definition_id
     WHERE d.source_key=$1`,
    [sourceKey],
  );
  return result.rows[0]?.count ?? 0;
}

async function drainNormalizers(maxTicks = 2_000): Promise<number> {
  let processed = 0;
  for (; processed < maxTicks; processed += 1) {
    if (!(await normalizerTick("node5-premerge-normalizer"))) return processed;
  }
  throw new Error(`normalization queue did not drain within ${maxTicks} ticks`);
}

async function drainProjections(maxTicks = 5_000): Promise<number> {
  let processed = 0;
  for (; processed < maxTicks; processed += 1) {
    if (!(await projectionTick("node5-premerge-projector"))) return processed;
  }
  throw new Error(`measurement projection queue did not drain within ${maxTicks} ticks`);
}

async function drainAggregations(maxTicks = 5_000): Promise<number> {
  let processed = 0;
  for (; processed < maxTicks; processed += 1) {
    if (!(await aggregationTick("node5-premerge-aggregator"))) return processed;
  }
  throw new Error(`measurement aggregation queue did not drain within ${maxTicks} ticks`);
}

async function measurementFactCount(measurementKey: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM measurement_fact_heads head
     JOIN measurement_calculation_versions calculation ON calculation.id=head.measurement_calculation_id
     JOIN measurement_definitions definition ON definition.id=calculation.measurement_definition_id
     WHERE definition.measurement_key=$1 AND head.fact_state='ACTIVE'`,
    [measurementKey],
  );
  return result.rows[0]?.count ?? 0;
}

async function latestFactTime(measurementKey: string): Promise<Date> {
  const result = await pool.query<{ event_time: Date | null }>(
    `SELECT head.event_time
     FROM measurement_fact_heads head
     JOIN measurement_calculation_versions calculation ON calculation.id=head.measurement_calculation_id
     JOIN measurement_definitions definition ON definition.id=calculation.measurement_definition_id
     WHERE definition.measurement_key=$1 AND head.fact_state='ACTIVE' AND head.event_time IS NOT NULL
     ORDER BY head.event_time DESC
     LIMIT 1`,
    [measurementKey],
  );
  const value = result.rows[0]?.event_time;
  if (!value) throw new Error(`measurement ${measurementKey} has no event-time fact`);
  return value;
}

async function requestJson(baseUrl: string, path: string, authenticated = true) {
  const init: RequestInit = authenticated
    ? { headers: { authorization: `Bearer ${API_TOKEN}` } }
    : {};
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = await response.json() as { data?: unknown; error?: { code?: string }; [key: string]: unknown };
  return { response, body };
}

async function runApiAcceptance(): Promise<void> {
  const server = createApiServer({ apiToken: API_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const unauthorized = await requestJson(baseUrl, "/v1/sources", false);
    assert(unauthorized.response.status === 401, "protected Node API did not reject an unauthenticated request");
    assert(JSON.stringify(unauthorized.body).includes(API_TOKEN) === false, "Node API echoed its service credential");

    const sources = await requestJson(baseUrl, "/v1/sources");
    assert(sources.response.status === 200, "/v1/sources failed");
    assert(Array.isArray(sources.body.data), "/v1/sources did not return an array");
    const publicKeys = new Set((sources.body.data as Array<{ sourceKey?: string }>).map((item) => item.sourceKey));
    for (const target of TARGETS) assert(publicKeys.has(target), `/v1/sources omitted ${target}`);
    assert(!publicKeys.has("TEST_SYNTHETIC"), "/v1/sources leaked TEST_SYNTHETIC");
    assert(!publicKeys.has("URLHAUS"), "/v1/sources exposed non-admitted URLHAUS");

    const records = await requestJson(baseUrl, "/v1/techint/records?sourceKey=GITHUB_ADVISORY_REVIEWED&limit=5");
    assert(records.response.status === 200, "canonical records API failed for GitHub reviewed advisories");
    assert(Array.isArray(records.body.data) && records.body.data.length > 0, "canonical records API returned no GitHub reviewed advisory records");
    const recordsText = JSON.stringify(records.body.data);
    assert(!recordsText.includes("payload_sha256") && !recordsText.includes("raw_source_records"), "read API exposed raw-storage internals");

    const catalog = await requestJson(baseUrl, "/v1/techint/measurement-catalog");
    assert(catalog.response.status === 200, "measurement catalog API failed");
    assert(Array.isArray(catalog.body.data), "measurement catalog did not return an array");
    const catalogKeys = new Set((catalog.body.data as Array<{ measurementKey?: string }>).map((item) => item.measurementKey));
    for (const key of [GITHUB_PUBLICATION, CISA_PUBLICATION, FEODO_LIVE]) {
      assert(catalogKeys.has(key), `measurement catalog omitted ${key}`);
    }

    const eventTime = await latestFactTime(GITHUB_PUBLICATION);
    const rangeFrom = new Date(eventTime.getTime() - 2 * 60 * 60 * 1_000).toISOString();
    const rangeTo = new Date(eventTime.getTime() + 2 * 60 * 60 * 1_000).toISOString();
    const series = await requestJson(
      baseUrl,
      `/v1/techint/measurements?measurementKey=${encodeURIComponent(GITHUB_PUBLICATION)}&from=${encodeURIComponent(rangeFrom)}&to=${encodeURIComponent(rangeTo)}&resolution=HOUR`,
    );
    assert(series.response.status === 200, "measurement series API failed for GitHub reviewed advisories");
    assert(Array.isArray(series.body.data) && series.body.data.length === 1, "measurement series API returned an unexpected series count");
    const points = (series.body.data as Array<{ points?: Array<{ materialized?: boolean; value?: number | null }> }>)[0]?.points ?? [];
    assert(points.some((point) => point.materialized === true && typeof point.value === "number" && point.value > 0), "measurement series did not expose a materialized positive publication bucket");

    const futureFrom = new Date(Date.now() + 48 * 60 * 60 * 1_000).toISOString();
    const futureTo = new Date(Date.now() + 52 * 60 * 60 * 1_000).toISOString();
    const futureSeries = await requestJson(
      baseUrl,
      `/v1/techint/measurements?measurementKey=${encodeURIComponent(GITHUB_PUBLICATION)}&from=${encodeURIComponent(futureFrom)}&to=${encodeURIComponent(futureTo)}&resolution=HOUR`,
    );
    assert(futureSeries.response.status === 200, "future no-coverage measurement query failed");
    const futurePoints = (futureSeries.body.data as Array<{ points?: Array<{ value?: number | null }> }>)[0]?.points ?? [];
    assert(futurePoints.length > 0 && futurePoints.every((point) => point.value === null), "no-coverage future buckets were fabricated as numeric zero");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main(): Promise<void> {
  try {
    await syncSourceDefinitions([...adapterRegistry.values()]);

    for (const sourceKey of adapterRegistry.keys()) await setSourceEnabled(sourceKey, false);

    const admissions = await pool.query<{
      source_key: string;
      admission_status: string | null;
      hash_valid: boolean | null;
      collection_allowed: boolean | null;
      canonical_projection_allowed: boolean | null;
      measurement_projection_allowed: boolean | null;
    }>(
      `SELECT source_key,admission_status,hash_valid,collection_allowed,
              canonical_projection_allowed,measurement_projection_allowed
       FROM current_source_admissions
       WHERE source_key=ANY($1::text[])
       ORDER BY source_key`,
      [[...TARGETS]],
    );
    assert(admissions.rows.length === TARGETS.length, "one or more selected sources lack admission state");
    for (const admission of admissions.rows) {
      assert(["ADMITTED", "ACTIVE"].includes(admission.admission_status ?? ""), `${admission.source_key} is not admitted`);
      assert(admission.hash_valid === true, `${admission.source_key} admission policy hash is invalid`);
      assert(admission.collection_allowed === true, `${admission.source_key} collection is not allowed`);
      assert(admission.canonical_projection_allowed === true, `${admission.source_key} canonical projection is not allowed`);
      assert(admission.measurement_projection_allowed === true, `${admission.source_key} measurement projection is not allowed`);
    }

    await syncMeasurementRegistry();

    await setSourceEnabled("FEODO_TRACKER", true);
    assert(await enqueueDueRuns(["FEODO_TRACKER"], 1) === 1, "Feodo bootstrap run was not enqueued");
    await drainSourceRun("FEODO_TRACKER", 3);

    await setSourceEnabled("GITHUB_ADVISORY_REVIEWED", true);
    assert(await enqueueDueRuns(["GITHUB_ADVISORY_REVIEWED"], 1) === 1, "GitHub reviewed advisory bootstrap run was not enqueued");
    await drainSourceRun("GITHUB_ADVISORY_REVIEWED", 10);

    await setSourceEnabled("CISA_ICS_CSAF", true);
    assert(await enqueueDueRuns(["CISA_ICS_CSAF"], 1) === 1, "CISA ICS bootstrap run was not enqueued");
    assert(await workerTick("node5-premerge-worker-cisa-discover"), "CISA ICS discovery work did not run");
    assert(await workerTick("node5-premerge-worker-cisa-page"), "CISA ICS first advisory page did not run");

    const rawSummary: Record<string, number> = {};
    for (const sourceKey of TARGETS) {
      const count = await rawCount(sourceKey, sourceKey === "CISA_ICS_CSAF");
      rawSummary[sourceKey] = count;
      assert(count > 0, `${sourceKey} produced no persisted non-control raw records`);
    }

    const duplicateAudit = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM (
         SELECT source_definition_id,source_record_id,payload_sha256,count(*)
         FROM raw_source_records
         GROUP BY source_definition_id,source_record_id,payload_sha256
         HAVING count(*)>1
       ) duplicates`,
    );
    assert((duplicateAudit.rows[0]?.count ?? 0) === 0, "immutable raw store contains exact duplicate revisions");

    const normalizedJobs = await drainNormalizers();
    const failedNormalization = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM normalization_jobs job
       JOIN source_definitions d ON d.id=job.source_definition_id
       WHERE d.source_key=ANY($1::text[]) AND job.state='FAILED'`,
      [[...TARGETS]],
    );
    assert((failedNormalization.rows[0]?.count ?? 0) === 0, "selected source normalization contains failed jobs");

    const canonicalSummary: Record<string, number> = {};
    for (const sourceKey of TARGETS) {
      const count = await canonicalCount(sourceKey);
      canonicalSummary[sourceKey] = count;
      assert(count > 0, `${sourceKey} produced no canonical evidence records`);
    }

    const discovered = await discoverProjectionJobs(5_000);
    const projected = await drainProjections();
    assert(discovered > 0 && projected > 0, "measurement projection runtime discovered no NODE-5 jobs");

    const githubFacts = await measurementFactCount(GITHUB_PUBLICATION);
    const cisaFacts = await measurementFactCount(CISA_PUBLICATION);
    const feodoBootstrapFacts = await measurementFactCount(FEODO_LIVE);
    assert(githubFacts > 0, "GitHub reviewed advisory publications produced no measurement facts");
    assert(cisaFacts > 0, "CISA ICS publications produced no measurement facts");
    assert(feodoBootstrapFacts === 0, "Feodo bootstrap incorrectly emitted a live-observation measurement fact");

    const aggregated = await drainAggregations();
    assert(aggregated > 0, "measurement aggregation runtime produced no materialized buckets");

    await runApiAcceptance();

    console.log(`PASS NODE5_LIVE_PIPELINE raw=${JSON.stringify(rawSummary)} canonical=${JSON.stringify(canonicalSummary)} normalizationTicks=${normalizedJobs} projectionJobs=${discovered} projectionTicks=${projected} aggregationTicks=${aggregated}`);
    console.log(`PASS NODE5_MEASUREMENTS githubPublications=${githubFacts} cisaPublications=${cisaFacts} feodoBootstrapLiveFacts=${feodoBootstrapFacts}`);
    console.log("PASS NODE5_API authenticated=true canonicalRecords=true measurementCatalog=true materializedSeries=true unknownNotZero=true");
  } finally {
    await pool.end();
  }
}

await main();

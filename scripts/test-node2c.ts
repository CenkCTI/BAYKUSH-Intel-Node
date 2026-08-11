import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { createNvdCveAdapterV2 } from "../src/sources/nvd-cve-normalization-v2.js";
import { adapterRegistry } from "../src/sources/registry.js";

const sourceKey = "NVD_CVE";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../tests/fixtures/nvd-cve/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

async function forceDue(sourceDefinitionId: string): Promise<void> {
  await pool.query(
    "UPDATE source_schedule_state SET next_due_at = now() - interval '1 second', updated_at = now() WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
}

async function latestRun(sourceDefinitionId: string) {
  const result = await pool.query<{
    state: string;
    trigger: string;
    purpose: string;
    raw_records_accepted: string;
    raw_records_inserted: string;
  }>(
    `SELECT state, trigger, purpose, raw_records_accepted::text, raw_records_inserted::text
     FROM collection_runs WHERE source_definition_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  assert.ok(row, "expected an NVD collection run");
  return row;
}

async function drainNormalization(sourceDefinitionId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const remaining = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM normalization_jobs
       WHERE source_definition_id = $1 AND state IN ('QUEUED','RUNNING')`,
      [sourceDefinitionId],
    );
    if ((remaining.rows[0]?.count ?? 0) === 0) return;
    assert.equal(await normalizerTick(`node2c-normalizer-${attempt}`), true);
  }
  assert.fail("NVD normalization queue did not drain within acceptance bound");
}

async function resetSource(sourceDefinitionId: string): Promise<void> {
  await setSourceEnabled(sourceKey, false);
  await pool.query("DELETE FROM canonical_evidence_records WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM normalization_jobs WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM raw_source_records WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query("DELETE FROM source_checkpoints WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query(
    "DELETE FROM collection_work_units WHERE run_id IN (SELECT id FROM collection_runs WHERE source_definition_id = $1)",
    [sourceDefinitionId],
  );
  await pool.query("DELETE FROM collection_runs WHERE source_definition_id = $1", [sourceDefinitionId]);
  await pool.query(
    `UPDATE source_schedule_state SET next_due_at = now(), last_enqueued_at = NULL, updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  await pool.query(
    `UPDATE source_health
     SET health_status = 'PAUSED', last_attempt_at = NULL, last_success_at = NULL,
         last_failure_at = NULL, consecutive_failures = 0,
         latest_failure_code = NULL, latest_failure_message = NULL, updated_at = now()
     WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
}

async function main(): Promise<void> {
  let nowMs = Date.parse("2026-08-12T00:00:00.000Z");
  let mode: "BOOTSTRAP" | "LIVE" | "ZERO" = "BOOTSTRAP";
  const requestUrls: URL[] = [];
  const requestHeaders: Headers[] = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requestUrls.push(url);
    requestHeaders.push(new Headers(init?.headers));
    if (mode === "BOOTSTRAP") {
      return jsonResponse(url.searchParams.get("startIndex") === "0" ? fixture("page-1.json") : fixture("page-2.json"));
    }
    if (mode === "LIVE") return jsonResponse(fixture("revised-cve.json"));
    return jsonResponse(fixture("zero-results.json"));
  };

  const adapter = createNvdCveAdapterV2({
    apiKey: "node2c-fixture-secret",
    pageSize: 2,
    now: () => nowMs,
    sleep: async () => {},
    fetchImpl,
  });
  adapterRegistry.set(sourceKey, adapter);
  await syncSourceDefinitions([adapter]);

  const source = await pool.query<{
    id: string;
    enabled: boolean;
    auth_requirement: string;
    semantic_contract_version: string;
  }>(
    "SELECT id, enabled, auth_requirement, semantic_contract_version FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId, "NVD_CVE source definition must exist");
  assert.equal(source.rows[0]?.enabled, false, "NVD must remain disabled until an operator enables it");
  assert.equal(source.rows[0]?.auth_requirement, "OPTIONAL");
  assert.equal(source.rows[0]?.semantic_contract_version, "nvd-cve-semantics-v2");
  assert.equal(adapter.normalizationVersion, "nvd-cve-normalization-v2");
  await resetSource(sourceDefinitionId);
  await setSourceEnabled(sourceKey, true);

  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2c-bootstrap-page-0"), true);
  const midBootstrap = await latestRun(sourceDefinitionId);
  assert.equal(midBootstrap.state, "QUEUED");
  const midCheckpoint = await pool.query<{ checkpoint: Record<string, unknown> }>(
    "SELECT checkpoint FROM source_checkpoints WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal((midCheckpoint.rows[0]?.checkpoint.activeWindow as Record<string, unknown>)?.startIndex, 2);
  assert.equal(midCheckpoint.rows[0]?.checkpoint.completedThrough, null, "completedThrough must not advance before the final page");

  assert.equal(await workerTick("node2c-bootstrap-page-1"), true);
  const bootstrap = await latestRun(sourceDefinitionId);
  assert.deepEqual(bootstrap, {
    state: "SUCCEEDED",
    trigger: "BOOTSTRAP",
    purpose: "INITIAL_BOOTSTRAP",
    raw_records_accepted: "3",
    raw_records_inserted: "3",
  });
  const bootstrapCheckpoint = await pool.query<{ checkpoint: Record<string, unknown> }>(
    "SELECT checkpoint FROM source_checkpoints WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(bootstrapCheckpoint.rows[0]?.checkpoint.completedThrough, "2026-08-12T00:00:00.000Z");
  assert.equal(bootstrapCheckpoint.rows[0]?.checkpoint.activeWindow, null);
  assert.equal(requestHeaders[0]?.get("apiKey"), "node2c-fixture-secret");
  assert.equal(requestUrls[0]?.searchParams.get("lastModStartDate"), "2026-08-11T00:00:00.000Z");
  assert.equal(requestUrls[0]?.searchParams.get("lastModEndDate"), "2026-08-12T00:00:00.000Z");
  assert.equal(requestUrls[0]?.toString().includes("node2c-fixture-secret"), false);

  await drainNormalization(sourceDefinitionId);
  const canonicalBootstrap = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND record_kind = 'VULNERABILITY_RECORD'`,
    [sourceDefinitionId],
  );
  assert.equal(canonicalBootstrap.rows[0]?.count, 3);
  const normalizationVersions = await pool.query<{ version: string; count: number }>(
    `SELECT normalization_version AS version, count(*)::int AS count
     FROM normalization_jobs WHERE source_definition_id = $1
     GROUP BY normalization_version`,
    [sourceDefinitionId],
  );
  assert.deepEqual(normalizationVersions.rows, [{ version: "nvd-cve-normalization-v2", count: 3 }]);
  const metricPredicates = await pool.query<{ predicate: string; count: number }>(
    `SELECT fact ->> 'predicate' AS predicate, count(*)::int AS count
     FROM canonical_evidence_records c, jsonb_array_elements(c.facts) fact
     WHERE c.source_definition_id = $1
       AND fact ->> 'predicate' IN ('nvd.metrics', 'nvd.cvss_metrics')
     GROUP BY fact ->> 'predicate'
     ORDER BY fact ->> 'predicate'`,
    [sourceDefinitionId],
  );
  assert.deepEqual(metricPredicates.rows, [{ predicate: "nvd.metrics", count: 1 }]);
  const rejected = await pool.query<{ value: string | null }>(
    `SELECT fact ->> 'value' AS value
     FROM canonical_evidence_records c, jsonb_array_elements(c.facts) fact
     WHERE c.source_definition_id = $1 AND c.canonical_key = 'cve:CVE-2026-10003'
       AND fact ->> 'predicate' = 'nvd.vuln_status' LIMIT 1`,
    [sourceDefinitionId],
  );
  assert.equal(rejected.rows[0]?.value, "Rejected");
  const additive = await pool.query<{ value: string | null }>(
    `SELECT payload ->> 'futureAdditiveField' AS value FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10001' LIMIT 1`,
    [sourceDefinitionId],
  );
  assert.equal(additive.rows[0]?.value, "preserve-me");

  mode = "LIVE";
  nowMs = Date.parse("2026-08-12T02:00:00.000Z");
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2c-live-revision"), true);
  const live = await latestRun(sourceDefinitionId);
  assert.deepEqual(live, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "1",
    raw_records_inserted: "1",
  });
  const liveUrl = requestUrls[2];
  assert.equal(liveUrl?.searchParams.get("lastModStartDate"), "2026-08-11T23:55:00.000Z");
  assert.equal(liveUrl?.searchParams.get("lastModEndDate"), "2026-08-12T02:00:00.000Z");
  await drainNormalization(sourceDefinitionId);
  const revisionCount = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10001'`,
    [sourceDefinitionId],
  );
  assert.equal(revisionCount.rows[0]?.count, 2, "changed NVD CVE must create an immutable raw revision");
  const cisaFacts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM canonical_evidence_records c, jsonb_array_elements(c.facts) fact
     WHERE c.source_definition_id = $1 AND lower(fact ->> 'predicate') LIKE '%cisa%'`,
    [sourceDefinitionId],
  );
  assert.equal(cisaFacts.rows[0]?.count, 0, "NVD-mirrored CISA fields must not become independent canonical KEV facts");

  mode = "ZERO";
  nowMs = Date.parse("2026-08-12T04:00:00.000Z");
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2c-zero-window"), true);
  const zero = await latestRun(sourceDefinitionId);
  assert.deepEqual(zero, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "0",
    raw_records_inserted: "0",
  });
  const failures = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM normalization_jobs
     WHERE source_definition_id = $1 AND state = 'FAILED'`,
    [sourceDefinitionId],
  );
  assert.equal(failures.rows[0]?.count, 0);

  await setSourceEnabled(sourceKey, false);
  console.log("NODE-2C NVD CVE acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { pool } from "../src/db/pool.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { createCisaKevAdapter } from "../src/sources/cisa-kev.js";
import { adapterRegistry } from "../src/sources/registry.js";

const sourceKey = "CISA_KEV";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../tests/fixtures/cisa-kev/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function jsonResponse(payload: unknown, etag: string, lastModified: string): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      etag,
      "last-modified": lastModified,
    },
  });
}

async function forceDue(sourceDefinitionId: string): Promise<void> {
  await pool.query(
    "UPDATE source_schedule_state SET next_due_at = now() - interval '1 second', updated_at = now() WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
}

async function latestRun(sourceDefinitionId: string) {
  const result = await pool.query<{
    trigger: string;
    purpose: string;
    state: string;
    raw_records_accepted: string;
    raw_records_inserted: string;
  }>(
    `SELECT trigger, purpose, state, raw_records_accepted::text, raw_records_inserted::text
     FROM collection_runs
     WHERE source_definition_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  assert.ok(row, "expected a CISA KEV collection run");
  return row;
}

async function drainCisaNormalization(sourceDefinitionId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const remaining = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM normalization_jobs
       WHERE source_definition_id = $1 AND state IN ('QUEUED','RUNNING')`,
      [sourceDefinitionId],
    );
    if ((remaining.rows[0]?.count ?? 0) === 0) return;
    assert.equal(await normalizerTick(`node2b-normalizer-${attempt}`), true);
  }
  assert.fail("CISA KEV normalization queue did not drain within acceptance bound");
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
  const v1 = fixture("catalog-v1.json");
  const v2 = fixture("catalog-v2.json");
  const requestHeaders: Headers[] = [];
  let requestNumber = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    requestHeaders.push(new Headers(init?.headers));
    requestNumber += 1;
    if (requestNumber === 1) return jsonResponse(v1, '"fixture-v1"', "Tue, 11 Aug 2026 18:00:00 GMT");
    if (requestNumber === 2) return jsonResponse(v2, '"fixture-v2"', "Tue, 11 Aug 2026 19:00:00 GMT");
    return new Response(null, { status: 304, headers: { etag: '"fixture-v2"' } });
  };

  const adapter = createCisaKevAdapter({ fetchImpl });
  adapterRegistry.set(sourceKey, adapter);
  await syncSourceDefinitions([adapter]);

  const source = await pool.query<{ id: string; enabled: boolean }>(
    "SELECT id, enabled FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId, "CISA_KEV source definition must exist");
  assert.equal(source.rows[0]?.enabled, false, "CISA KEV must remain disabled until an operator enables it");
  await resetSource(sourceDefinitionId);
  await setSourceEnabled(sourceKey, true);

  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2b-bootstrap-worker"), true);
  const bootstrap = await latestRun(sourceDefinitionId);
  assert.deepEqual(bootstrap, {
    trigger: "BOOTSTRAP",
    purpose: "INITIAL_BOOTSTRAP",
    state: "SUCCEEDED",
    raw_records_accepted: "4",
    raw_records_inserted: "4",
  });

  const bootstrapRaw = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM raw_source_records WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(bootstrapRaw.rows[0]?.count, 4);
  const additiveRaw = await pool.query<{ value: string | null }>(
    `SELECT payload ->> 'futureAdditiveField' AS value
     FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10001'`,
    [sourceDefinitionId],
  );
  assert.equal(additiveRaw.rows[0]?.value, "preserve-me");

  await drainCisaNormalization(sourceDefinitionId);
  const firstCanonical = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND record_kind = 'KNOWN_EXPLOITED_VULNERABILITY'`,
    [sourceDefinitionId],
  );
  assert.equal(firstCanonical.rows[0]?.count, 3);
  const unknownRansomware = await pool.query<{ value: string | null }>(
    `SELECT fact ->> 'value' AS value
     FROM canonical_evidence_records c,
          jsonb_array_elements(c.facts) AS fact
     WHERE c.source_definition_id = $1
       AND c.canonical_key = 'cve:CVE-2026-10001'
       AND fact ->> 'predicate' = 'kev.known_ransomware_campaign_use'
     LIMIT 1`,
    [sourceDefinitionId],
  );
  assert.equal(unknownRansomware.rows[0]?.value, "Unknown");
  const datePrecision = await pool.query<{ published_at: Date | null; effective_at: Date | null }>(
    `SELECT published_at, effective_at FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10001'
     ORDER BY received_at LIMIT 1`,
    [sourceDefinitionId],
  );
  assert.equal(datePrecision.rows[0]?.published_at, null);
  assert.equal(datePrecision.rows[0]?.effective_at, null);

  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2b-live-worker"), true);
  const live = await latestRun(sourceDefinitionId);
  assert.deepEqual(live, {
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    state: "SUCCEEDED",
    raw_records_accepted: "4",
    raw_records_inserted: "3",
  });
  await drainCisaNormalization(sourceDefinitionId);

  const rawAfterRevision = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM raw_source_records WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(rawAfterRevision.rows[0]?.count, 7, "unchanged entry must not create a raw revision");
  const cveRevisionCount = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10001'`,
    [sourceDefinitionId],
  );
  assert.equal(cveRevisionCount.rows[0]?.count, 2, "changed entry must create an immutable revision");
  const unchangedCount = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10002'`,
    [sourceDefinitionId],
  );
  assert.equal(unchangedCount.rows[0]?.count, 1);
  const manifest = await pool.query<{ cve_ids: unknown }>(
    `SELECT payload -> 'cveIds' AS cve_ids FROM raw_source_records
     WHERE source_definition_id = $1
       AND source_record_id = '__catalog_manifest__'
       AND payload ->> 'catalogVersion' = 'fixture.2'`,
    [sourceDefinitionId],
  );
  assert.deepEqual(manifest.rows[0]?.cve_ids, ["CVE-2026-10001", "CVE-2026-10002", "CVE-2026-10004"]);

  const canonicalAfterRevision = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND record_kind = 'KNOWN_EXPLOITED_VULNERABILITY'`,
    [sourceDefinitionId],
  );
  assert.equal(canonicalAfterRevision.rows[0]?.count, 5);

  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2b-conditional-worker"), true);
  const unchangedRun = await latestRun(sourceDefinitionId);
  assert.equal(unchangedRun.state, "SUCCEEDED");
  assert.equal(unchangedRun.raw_records_accepted, "0");
  assert.equal(unchangedRun.raw_records_inserted, "0");
  assert.equal(requestHeaders[2]?.get("if-none-match"), '"fixture-v2"');

  const checkpoint = await pool.query<{ checkpoint: Record<string, unknown> }>(
    "SELECT checkpoint FROM source_checkpoints WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(checkpoint.rows[0]?.checkpoint.catalogVersion, "fixture.2");
  assert.equal(checkpoint.rows[0]?.checkpoint.count, 3);
  assert.equal(checkpoint.rows[0]?.checkpoint.retrievalChannel, "GITHUB_OFFICIAL_MIRROR");

  await setSourceEnabled(sourceKey, false);
  console.log("NODE-2B CISA KEV acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

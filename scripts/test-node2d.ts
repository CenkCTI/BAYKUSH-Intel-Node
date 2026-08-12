import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { pool } from "../src/db/pool.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { createFirstEpssAdapter } from "../src/sources/first-epss.js";
import { adapterRegistry } from "../src/sources/registry.js";

const sourceKey = "FIRST_EPSS";

function gzipDataset(date: string, rows: readonly string[], modelVersion = "v2026.06.15"): Buffer {
  return gzipSync([
    `#model_version:${modelVersion},score_date:${date}T00:00:00+0000`,
    "cve,epss,percentile",
    ...rows,
    "",
  ].join("\n"));
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
  assert.ok(row, "expected a FIRST EPSS collection run");
  return row;
}

async function drainNormalization(sourceDefinitionId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const remaining = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM normalization_jobs
       WHERE source_definition_id = $1 AND state IN ('QUEUED','RUNNING')`,
      [sourceDefinitionId],
    );
    if ((remaining.rows[0]?.count ?? 0) === 0) return;
    assert.equal(await normalizerTick(`node2d-normalizer-${attempt}`), true);
  }
  assert.fail("FIRST EPSS normalization queue did not drain within acceptance bound");
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
  let mode: "DAY1" | "DAY2" | "SAME" = "DAY1";
  const day1 = gzipDataset("2026-08-12", [
    "CVE-2026-10001,0.91000,0.99800",
    "CVE-2026-10002,0.50000,0.95000",
    "CVE-2026-10003,0.10000,0.90000",
    "CVE-2026-10004,0.09999,0.89900",
  ]);
  const day2 = gzipDataset("2026-08-13", [
    "CVE-2026-10001,0.92000,0.99850",
    "CVE-2026-10002,0.50000,0.95000",
    "CVE-2026-10003,0.11000,0.90500",
    "CVE-2026-10004,0.09999,0.89900",
  ]);

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/epss_scores-current.csv.gz") {
      const date = mode === "DAY1" ? "2026-08-12" : "2026-08-13";
      return new Response(null, {
        status: 302,
        headers: { location: `https://epss.empiricalsecurity.com/epss_scores-${date}.csv.gz` },
      });
    }
    const payload = mode === "DAY1" ? day1 : day2;
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        etag: mode === "DAY1" ? "day1-etag" : "day2-etag",
        "last-modified": mode === "DAY1" ? "Wed, 12 Aug 2026 13:31:00 GMT" : "Thu, 13 Aug 2026 13:31:00 GMT",
      },
    });
  };

  const adapter = createFirstEpssAdapter({ fetchImpl });
  adapterRegistry.set(sourceKey, adapter);
  await syncSourceDefinitions([adapter]);

  const source = await pool.query<{ id: string; enabled: boolean; auth_requirement: string }>(
    "SELECT id, enabled, auth_requirement FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId, "FIRST_EPSS source definition must exist");
  assert.equal(source.rows[0]?.enabled, false, "FIRST EPSS must remain disabled until explicitly enabled");
  assert.equal(source.rows[0]?.auth_requirement, "NONE");

  await resetSource(sourceDefinitionId);
  await setSourceEnabled(sourceKey, true);
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2d-bootstrap"), true);

  const bootstrap = await latestRun(sourceDefinitionId);
  assert.deepEqual(bootstrap, {
    state: "SUCCEEDED",
    trigger: "BOOTSTRAP",
    purpose: "INITIAL_BOOTSTRAP",
    raw_records_accepted: "4",
    raw_records_inserted: "4",
  });

  await drainNormalization(sourceDefinitionId);
  const bootstrapRaw = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM raw_source_records WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(bootstrapRaw.rows[0]?.count, 4, "three selected scores plus one manifest must be raw evidence");

  const manifest = await pool.query<{
    dataset_date: string | null;
    model_version: string | null;
    total_rows: number | null;
    qualified_rows: number | null;
    selected_rows: number | null;
  }>(
    `SELECT payload ->> 'datasetDate' AS dataset_date,
            payload ->> 'modelVersion' AS model_version,
            (payload ->> 'totalRows')::int AS total_rows,
            (payload ->> 'qualifiedRows')::int AS qualified_rows,
            (payload ->> 'selectedRows')::int AS selected_rows
     FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'dataset-manifest'
     ORDER BY received_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  assert.deepEqual(manifest.rows[0], {
    dataset_date: "2026-08-12",
    model_version: "v2026.06.15",
    total_rows: 4,
    qualified_rows: 3,
    selected_rows: 3,
  });

  const canonical = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND record_kind = 'EXPLOIT_PROBABILITY_SCORE'`,
    [sourceDefinitionId],
  );
  assert.equal(canonical.rows[0]?.count, 3);

  const unexpectedKinds = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND record_kind <> 'EXPLOIT_PROBABILITY_SCORE'`,
    [sourceDefinitionId],
  );
  assert.equal(unexpectedKinds.rows[0]?.count, 0);

  const unsafeFacts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM canonical_evidence_records c, jsonb_array_elements(c.facts) fact
     WHERE c.source_definition_id = $1
       AND lower(fact ->> 'predicate') ~ '(risk|severity|attack|active_exploitation|priority)'`,
    [sourceDefinitionId],
  );
  assert.equal(unsafeFacts.rows[0]?.count, 0, "EPSS canonical facts must not manufacture risk or exploitation observations");

  const manifestNormalization = await pool.query<{ canonical_records_written: number; state: string }>(
    `SELECT j.canonical_records_written, j.state
     FROM normalization_jobs j
     JOIN raw_source_records r ON r.id = j.raw_record_id
     WHERE j.source_definition_id = $1 AND r.source_record_id = 'dataset-manifest'
     ORDER BY j.created_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  assert.deepEqual(manifestNormalization.rows[0], { canonical_records_written: 0, state: "SUCCEEDED" });

  mode = "DAY2";
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2d-day2"), true);
  const live = await latestRun(sourceDefinitionId);
  assert.deepEqual(live, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "4",
    raw_records_inserted: "4",
  });
  await drainNormalization(sourceDefinitionId);

  const revisionCount = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = 'CVE-2026-10002'`,
    [sourceDefinitionId],
  );
  assert.equal(revisionCount.rows[0]?.count, 2, "same EPSS score on a new score date must remain a new immutable time-series revision");

  mode = "SAME";
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick("node2d-same-day-idempotency"), true);
  const same = await latestRun(sourceDefinitionId);
  assert.deepEqual(same, {
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

  const checkpoint = await pool.query<{ checkpoint: Record<string, unknown> }>(
    "SELECT checkpoint FROM source_checkpoints WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  assert.equal(checkpoint.rows[0]?.checkpoint.completedDatasetDate, "2026-08-13");
  assert.equal(checkpoint.rows[0]?.checkpoint.completedModelVersion, "v2026.06.15");

  await setSourceEnabled(sourceKey, false);
  console.log("NODE-2D FIRST EPSS acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

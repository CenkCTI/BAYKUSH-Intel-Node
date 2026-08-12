import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { adapterRegistry } from "../src/sources/registry.js";
import { createMalwareBazaarAdapter } from "../src/sources/malwarebazaar.js";

const sourceKey = "MALWAREBAZAAR";
const authKey = "node2f-fixture-auth-key";
let nowMs = Date.parse("2026-08-12T12:00:00.000Z");
let revision = false;
const requests: Array<{ method: string | undefined; auth: string | null; body: string }> = [];

function sample(seed: string, overrides: Record<string, unknown> = {}) {
  return {
    sha256_hash: seed.repeat(64).slice(0, 64),
    sha3_384_hash: seed === "a" ? "b".repeat(96) : null,
    sha1_hash: (seed === "a" ? "c" : "f").repeat(40),
    md5_hash: (seed === "a" ? "d" : "1").repeat(32),
    first_seen: "2026-08-12 11:30:00",
    last_seen: null,
    file_name: `${seed}.exe`,
    file_size: 123456,
    file_type_mime: "application/x-dosexec",
    file_type: "exe",
    file_format: "pe",
    file_arch: "x86-64",
    reporter: "fixture-reporter",
    anonymous: 0,
    signature: seed === "a" ? (revision ? "ChangedRAT" : "FixtureRAT") : null,
    imphash: "e".repeat(32),
    tlsh: null,
    telfhash: null,
    gimphash: null,
    ssdeep: null,
    magika: "pebin",
    trid: null,
    dhash_icon: null,
    tags: ["fixture"],
    intelligence: { downloads: 9, uploads: 2 },
    origin_country: "US",
    ...overrides,
  };
}

function currentDataset() {
  return [
    sample("a"),
    sample("2", { file_type: "elf", file_format: "elf", file_arch: "ARM", signature: "Mirai" }),
    sample("3", { file_type: "zip", file_format: "zip", signature: null }),
    sample("4", { file_type: "jar", file_format: "jar", signature: "Adwind" }),
    sample("5", { imphash: "9".repeat(32), signature: null }),
    sample("6", { future_field: { nested: "preserved" }, signature: null }),
  ];
}

const fetchImpl: typeof fetch = async (_input, init) => {
  const headers = new Headers(init?.headers);
  const body = typeof init?.body === "string" ? init.body : "";
  const params = new URLSearchParams(body);
  assert.equal(init?.method, "POST");
  assert.equal(headers.get("Auth-Key"), authKey);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(params.get("query"), "get_recent");
  assert.equal(params.get("selector"), "time");
  assert.equal(body.includes("get_file"), false);
  assert.equal(body.includes(authKey), false);
  requests.push({ method: init?.method, auth: headers.get("Auth-Key"), body });
  return new Response(JSON.stringify({ query_status: "ok", data: currentDataset() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

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
     FROM collection_runs WHERE source_definition_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  assert.ok(row, "expected a MalwareBazaar collection run");
  return row;
}

async function drainNormalization(sourceDefinitionId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const remaining = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM normalization_jobs
       WHERE source_definition_id = $1 AND state IN ('QUEUED','RUNNING')`,
      [sourceDefinitionId],
    );
    if ((remaining.rows[0]?.count ?? 0) === 0) return;
    assert.equal(await normalizerTick(`node2f-normalizer-${attempt}`), true);
  }
  assert.fail("MalwareBazaar normalization queue did not drain within acceptance bound");
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
    `UPDATE source_health SET health_status = 'PAUSED', last_attempt_at = NULL, last_success_at = NULL,
      last_failure_at = NULL, consecutive_failures = 0, latest_failure_code = NULL,
      latest_failure_message = NULL, updated_at = now() WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
}

async function runDue(sourceDefinitionId: string, workerId: string) {
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick(workerId), true);
  return latestRun(sourceDefinitionId);
}

async function countRows(table: "raw_source_records" | "canonical_evidence_records", sourceDefinitionId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table} WHERE source_definition_id = $1`,
    [sourceDefinitionId],
  );
  return result.rows[0]?.count ?? 0;
}

async function main(): Promise<void> {
  const adapter = createMalwareBazaarAdapter({ authKey, fetchImpl, now: () => nowMs });
  adapterRegistry.set(sourceKey, adapter);
  await syncSourceDefinitions([adapter]);

  const source = await pool.query<{
    id: string;
    enabled: boolean;
    auth_requirement: string;
    source_class: string;
    observation_basis: string;
    commercial_use_status: string;
    redistribution_status: string;
  }>(
    `SELECT id, enabled, auth_requirement, source_class, observation_basis,
            commercial_use_status, redistribution_status
     FROM source_definitions WHERE source_key = $1`,
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId, "MALWAREBAZAAR source definition must exist");
  assert.equal(source.rows[0]?.enabled, false);
  assert.equal(source.rows[0]?.auth_requirement, "REQUIRED");
  assert.equal(source.rows[0]?.source_class, "MALWARE_SAMPLE_REPOSITORY");
  assert.equal(source.rows[0]?.observation_basis, "PUBLISHED");
  assert.equal(source.rows[0]?.commercial_use_status, "RESTRICTED");
  assert.equal(source.rows[0]?.redistribution_status, "UNKNOWN");

  await resetSource(sourceDefinitionId);
  await setSourceEnabled(sourceKey, true);

  const bootstrap = await runDue(sourceDefinitionId, "node2f-bootstrap");
  assert.deepEqual(bootstrap, {
    state: "SUCCEEDED",
    trigger: "BOOTSTRAP",
    purpose: "INITIAL_BOOTSTRAP",
    raw_records_accepted: "7",
    raw_records_inserted: "7",
  });
  await drainNormalization(sourceDefinitionId);
  assert.equal(await countRows("raw_source_records", sourceDefinitionId), 7);
  assert.equal(await countRows("canonical_evidence_records", sourceDefinitionId), 6);

  const kinds = await pool.query<{ record_kind: string; count: number }>(
    `SELECT record_kind, count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 GROUP BY record_kind`,
    [sourceDefinitionId],
  );
  assert.deepEqual(kinds.rows, [{ record_kind: "MALWARE_SAMPLE_RECORD", count: 6 }]);

  const sampleRecord = await pool.query<{
    entities: Array<{ kind: string; key: string; label?: string }>;
    facts: Array<{ predicate: string; value: unknown }>;
    effective_at: Date | null;
    published_at: Date | null;
    upstream_updated_at: Date | null;
  }>(
    `SELECT entities, facts, effective_at, published_at, upstream_updated_at
     FROM canonical_evidence_records WHERE source_definition_id = $1 AND source_record_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [sourceDefinitionId, "a".repeat(64)],
  );
  const canonical = sampleRecord.rows[0];
  assert.ok(canonical);
  assert.ok(canonical.entities.some((entity) => entity.kind === "HASH" && entity.key === `sha256:${"a".repeat(64)}`));
  assert.ok(canonical.entities.some((entity) => entity.kind === "MALWARE" && entity.key === "malwarebazaar:signature:fixturerat"));
  assert.ok(canonical.facts.some((fact) => fact.predicate === "malwarebazaar.file_type" && fact.value === "exe"));
  assert.equal(canonical.published_at, null);
  assert.equal(canonical.upstream_updated_at, null);
  assert.equal(canonical.effective_at?.toISOString(), "2026-08-12T11:30:00.000Z");

  const unsafeFacts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records c,
       jsonb_array_elements(c.facts) fact
     WHERE c.source_definition_id = $1
       AND lower(fact ->> 'predicate') ~ '(infection|attack|victim|risk|severity|priority|attacker_country|target_country|current_maliciousness)'`,
    [sourceDefinitionId],
  );
  assert.equal(unsafeFacts.rows[0]?.count, 0);

  const manifestJob = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM normalization_jobs j
     JOIN raw_source_records r ON r.id = j.raw_record_id
     WHERE j.source_definition_id = $1 AND r.source_record_id = 'query-manifest'
       AND j.state = 'SUCCEEDED' AND j.canonical_records_written = 0`,
    [sourceDefinitionId],
  );
  assert.equal(manifestJob.rows[0]?.count, 1);

  nowMs += 15 * 60_000;
  const exactSame = await runDue(sourceDefinitionId, "node2f-exact-idempotency");
  assert.deepEqual(exactSame, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "0",
    raw_records_inserted: "0",
  });
  assert.equal(await countRows("raw_source_records", sourceDefinitionId), 7);
  assert.equal(await countRows("canonical_evidence_records", sourceDefinitionId), 6);

  revision = true;
  nowMs += 15 * 60_000;
  const changed = await runDue(sourceDefinitionId, "node2f-revision");
  assert.deepEqual(changed, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "7",
    raw_records_inserted: "2",
  });
  await drainNormalization(sourceDefinitionId);
  assert.equal(await countRows("raw_source_records", sourceDefinitionId), 9);
  assert.equal(await countRows("canonical_evidence_records", sourceDefinitionId), 7);

  const revisions = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = $2`,
    [sourceDefinitionId, "a".repeat(64)],
  );
  assert.equal(revisions.rows[0]?.count, 2);

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
  assert.equal(checkpoint.rows[0]?.checkpoint.recoveryWindowSeconds, 3600);
  assert.equal(checkpoint.rows[0]?.checkpoint.recoveryGapExceeded, false);
  assert.equal(checkpoint.rows[0]?.checkpoint.previousRecordCount, 6);

  const leaked = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM (
       SELECT payload::text AS value FROM raw_source_records WHERE source_definition_id = $1
       UNION ALL SELECT checkpoint::text FROM source_checkpoints WHERE source_definition_id = $1
       UNION ALL SELECT descriptor::text FROM collection_work_units
         WHERE run_id IN (SELECT id FROM collection_runs WHERE source_definition_id = $1)
       UNION ALL SELECT facts::text FROM canonical_evidence_records WHERE source_definition_id = $1
     ) values_to_scan WHERE value LIKE '%' || $2 || '%'`,
    [sourceDefinitionId, authKey],
  );
  assert.equal(leaked.rows[0]?.count, 0);
  assert.ok(requests.length >= 3);
  assert.ok(requests.every((request) => !request.body.includes(authKey)));

  await setSourceEnabled(sourceKey, false);
  console.log("NODE-2F MalwareBazaar acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

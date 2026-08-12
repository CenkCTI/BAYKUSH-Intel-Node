import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { normalizerTick } from "../src/runtime/normalization.js";
import { enqueueDueRuns, setSourceEnabled } from "../src/runtime/repository.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";
import { workerTick } from "../src/runtime/worker.js";
import { adapterRegistry } from "../src/sources/registry.js";
import { createThreatFoxAdapter } from "../src/sources/threatfox.js";

const sourceKey = "THREATFOX";
const authKey = "node2e-fixture-auth-key";
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let mode: "BASE" | "REVISION" = "BASE";
const requests: Array<{ method: string | undefined; auth: string | null; body: unknown }> = [];

function fixtureIoc(input: {
  id: string;
  ioc: string;
  iocType: string;
  confidence?: number;
  malware?: string | null;
}) {
  return {
    id: input.id,
    ioc: input.ioc,
    threat_type: "botnet_cc",
    threat_type_desc: "Botnet command and control infrastructure",
    ioc_type: input.iocType,
    ioc_type_desc: `fixture ${input.iocType}`,
    malware: input.malware === undefined ? "win.cobalt_strike" : input.malware,
    malware_printable: input.malware === null ? null : "Cobalt Strike",
    malware_alias: input.malware === null ? null : "BEACON,CobaltStrike",
    malware_malpedia: input.malware === null ? null : "https://malpedia.caad.fkie.fraunhofer.de/details/win.cobalt_strike",
    confidence_level: input.confidence ?? 75,
    first_seen: "2026-08-12 08:00:00 UTC",
    last_seen: null,
    reporter: "abuse_ch",
    reference: "https://example.test/source-report",
    tags: ["fixture"],
  };
}

function currentDataset() {
  return [
    fixtureIoc({ id: "1001", ioc: "Example.COM.", iocType: "domain", confidence: mode === "REVISION" ? 90 : 75 }),
    fixtureIoc({ id: "1002", ioc: "https://Example.com/Login?Token=ABC", iocType: "url" }),
    fixtureIoc({ id: "1003", ioc: "192.0.2.10:8443", iocType: "ip:port" }),
    fixtureIoc({ id: "1004", ioc: "a".repeat(32), iocType: "md5_hash", malware: null }),
    fixtureIoc({ id: "1005", ioc: "b".repeat(40), iocType: "sha1_hash", malware: null }),
    fixtureIoc({ id: "1006", ioc: "c".repeat(64), iocType: "sha256_hash", malware: null }),
  ];
}

const fetchImpl: typeof fetch = async (_input, init) => {
  const headers = new Headers(init?.headers);
  const bodyText = typeof init?.body === "string" ? init.body : "";
  const body = JSON.parse(bodyText) as { query?: unknown; days?: unknown };
  assert.equal(init?.method, "POST");
  assert.equal(headers.get("Auth-Key"), authKey);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(body.query, "get_iocs");
  assert.ok(typeof body.days === "number" && body.days >= 1 && body.days <= 7);
  assert.equal(bodyText.includes(authKey), false, "ThreatFox secret must never be serialized into request body");
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
     FROM collection_runs WHERE source_definition_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  const row = result.rows[0];
  assert.ok(row, "expected a ThreatFox collection run");
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
    assert.equal(await normalizerTick(`node2e-normalizer-${attempt}`), true);
  }
  assert.fail("ThreatFox normalization queue did not drain within acceptance bound");
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

async function rawCount(sourceDefinitionId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM raw_source_records WHERE source_definition_id = $1",
    [sourceDefinitionId],
  );
  return result.rows[0]?.count ?? 0;
}

async function canonicalCount(sourceDefinitionId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND record_kind = 'IOC_REPORT'`,
    [sourceDefinitionId],
  );
  return result.rows[0]?.count ?? 0;
}

async function runDue(sourceDefinitionId: string, workerId: string) {
  await forceDue(sourceDefinitionId);
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1);
  assert.equal(await workerTick(workerId), true);
  return latestRun(sourceDefinitionId);
}

async function main(): Promise<void> {
  const adapter = createThreatFoxAdapter({ authKey, fetchImpl, now: () => nowMs });
  adapterRegistry.set(sourceKey, adapter);
  await syncSourceDefinitions([adapter]);

  const source = await pool.query<{ id: string; enabled: boolean; auth_requirement: string; source_class: string; observation_basis: string }>(
    `SELECT id, enabled, auth_requirement, source_class, observation_basis
     FROM source_definitions WHERE source_key = $1`,
    [sourceKey],
  );
  const sourceDefinitionId = source.rows[0]?.id;
  assert.ok(sourceDefinitionId, "THREATFOX source definition must exist");
  assert.equal(source.rows[0]?.enabled, false, "ThreatFox must remain disabled until explicitly enabled");
  assert.equal(source.rows[0]?.auth_requirement, "REQUIRED");
  assert.equal(source.rows[0]?.source_class, "IOC_SHARING");
  assert.equal(source.rows[0]?.observation_basis, "REPORTED");

  await resetSource(sourceDefinitionId);
  await setSourceEnabled(sourceKey, true);

  const bootstrap = await runDue(sourceDefinitionId, "node2e-bootstrap");
  assert.deepEqual(bootstrap, {
    state: "SUCCEEDED",
    trigger: "BOOTSTRAP",
    purpose: "INITIAL_BOOTSTRAP",
    raw_records_accepted: "7",
    raw_records_inserted: "7",
  });
  assert.equal((requests[0]?.body as { days?: number }).days, 7, "ThreatFox bootstrap must use the maximum seven-day recent window");
  await drainNormalization(sourceDefinitionId);
  assert.equal(await rawCount(sourceDefinitionId), 7, "six IOC reports plus one query manifest must be raw evidence");
  assert.equal(await canonicalCount(sourceDefinitionId), 6, "query manifest must not become canonical intelligence");

  const canonicalKinds = await pool.query<{ record_kind: string; count: number }>(
    `SELECT record_kind, count(*)::int AS count FROM canonical_evidence_records
     WHERE source_definition_id = $1 GROUP BY record_kind`,
    [sourceDefinitionId],
  );
  assert.deepEqual(canonicalKinds.rows, [{ record_kind: "IOC_REPORT", count: 6 }]);

  const unsafeFacts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM canonical_evidence_records c, jsonb_array_elements(c.facts) fact
     WHERE c.source_definition_id = $1
       AND lower(fact ->> 'predicate') ~ '(attack|risk|severity|priority|threat_level|active_exploitation|attacker_country|independent_confirmation)'`,
    [sourceDefinitionId],
  );
  assert.equal(unsafeFacts.rows[0]?.count, 0, "ThreatFox normalization must not manufacture attacks, risk, priority, or independent corroboration");

  const ipRecord = await pool.query<{ entities: unknown; facts: unknown; published_at: Date | null; effective_at: Date | null; upstream_updated_at: Date | null }>(
    `SELECT entities, facts, published_at, effective_at, upstream_updated_at
     FROM canonical_evidence_records
     WHERE source_definition_id = $1 AND source_record_id = '1003'
     ORDER BY created_at DESC LIMIT 1`,
    [sourceDefinitionId],
  );
  const ip = ipRecord.rows[0];
  assert.ok(ip);
  assert.deepEqual(ip.entities, [
    { kind: "IP", key: "192.0.2.10", label: "192.0.2.10" },
    { kind: "MALWARE", key: "malpedia:win.cobalt_strike", label: "Cobalt Strike" },
  ]);
  assert.ok(JSON.stringify(ip.facts).includes('"predicate":"threatfox.port","value":8443'));
  assert.equal(ip.published_at, null);
  assert.equal(ip.upstream_updated_at, null);
  assert.equal(ip.effective_at?.toISOString(), "2026-08-12T08:00:00.000Z");

  const manifestJobs = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM normalization_jobs j
     JOIN raw_source_records r ON r.id = j.raw_record_id
     WHERE j.source_definition_id = $1
       AND r.source_record_id = 'query-manifest'
       AND j.state = 'SUCCEEDED'
       AND j.canonical_records_written = 0`,
    [sourceDefinitionId],
  );
  assert.equal(manifestJobs.rows[0]?.count, 1);

  nowMs += 60 * 60 * 1_000;
  const firstLive = await runDue(sourceDefinitionId, "node2e-first-live");
  assert.deepEqual(firstLive, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "7",
    raw_records_inserted: "1",
  });
  assert.equal((requests[1]?.body as { days?: number }).days, 1, "normal live polling must use one-day overlap");
  await drainNormalization(sourceDefinitionId);
  assert.equal(await rawCount(sourceDefinitionId), 8, "query-window change must be preserved as a new manifest while unchanged IOCs deduplicate");
  assert.equal(await canonicalCount(sourceDefinitionId), 6);

  nowMs += 60 * 60 * 1_000;
  const exactSame = await runDue(sourceDefinitionId, "node2e-exact-idempotency");
  assert.deepEqual(exactSame, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "0",
    raw_records_inserted: "0",
  });
  assert.equal(await rawCount(sourceDefinitionId), 8);
  assert.equal(await canonicalCount(sourceDefinitionId), 6);

  mode = "REVISION";
  nowMs += 60 * 60 * 1_000;
  const revision = await runDue(sourceDefinitionId, "node2e-revision");
  assert.deepEqual(revision, {
    state: "SUCCEEDED",
    trigger: "SCHEDULED",
    purpose: "LIVE_INCREMENTAL",
    raw_records_accepted: "7",
    raw_records_inserted: "2",
  });
  await drainNormalization(sourceDefinitionId);
  assert.equal(await rawCount(sourceDefinitionId), 10, "changed IOC and changed response manifest must create immutable raw revisions");
  assert.equal(await canonicalCount(sourceDefinitionId), 7, "only the changed IOC report should create one new canonical revision");

  const changedRevisions = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = '1001'`,
    [sourceDefinitionId],
  );
  assert.equal(changedRevisions.rows[0]?.count, 2);
  const unchangedRevisions = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM raw_source_records
     WHERE source_definition_id = $1 AND source_record_id = '1002'`,
    [sourceDefinitionId],
  );
  assert.equal(unchangedRevisions.rows[0]?.count, 1);

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
  assert.equal(checkpoint.rows[0]?.checkpoint.recoveryWindowDays, 1);
  assert.equal(checkpoint.rows[0]?.checkpoint.recoveryGapExceeded, false);
  assert.equal(checkpoint.rows[0]?.checkpoint.previousRecordCount, 6);

  const leakedSecrets = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM (
       SELECT payload::text AS value FROM raw_source_records WHERE source_definition_id = $1
       UNION ALL
       SELECT checkpoint::text FROM source_checkpoints WHERE source_definition_id = $1
       UNION ALL
       SELECT descriptor::text FROM collection_work_units
       WHERE run_id IN (SELECT id FROM collection_runs WHERE source_definition_id = $1)
     ) secret_scan
     WHERE value LIKE '%' || $2 || '%'`,
    [sourceDefinitionId, authKey],
  );
  assert.equal(leakedSecrets.rows[0]?.count, 0, "ThreatFox Auth-Key must not persist in raw, checkpoints, or work descriptors");

  await setSourceEnabled(sourceKey, false);
  console.log("NODE-2E ThreatFox acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

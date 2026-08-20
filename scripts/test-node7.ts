import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApiServer } from "../src/api/server.js";
import { pool } from "../src/db/pool.js";
import { processNode7ActivityBatch } from "../src/discovery/activity.js";
import { processNode7ConvergenceBatch } from "../src/discovery/convergence.js";
import { processNode7DiscoveryBatch } from "../src/discovery/discovery.js";

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface SourceRow {
  id: string;
  source_key: string;
  upstream_origin_key: string;
  source_class: string;
  observation_basis: string;
  adapter_version: string;
  semantic_contract_version: string;
  represents: string;
  does_not_represent: string;
}

interface RetractionRow {
  current_revision_id: string;
  entity_key: string;
  entity_type: string;
  entity_role: string;
  source_definition_id: string;
  revision_number: number;
  source_record_id: string;
  canonical_record_id: string;
  raw_record_id: string;
  observed_time: Date | null;
  observed_date: string | null;
  time_precision: "INSTANT" | "DATE";
  observation_basis: string;
  input_fingerprint: string;
}

interface ApiEnvelopeRecord {
  apiVersion: string;
  data: Record<string, unknown>;
}

interface ApiEnvelopeList {
  apiVersion: string;
  data: unknown[];
}

interface RelatedEnvelope {
  data: {
    relationshipBasis: string;
    records: unknown[];
  };
}

interface LineageEnvelope {
  data: {
    nodes: Array<{ data: Record<string, unknown> }>;
    edges: unknown[];
  };
}

async function ensureTestSource(input: {
  sourceKey: string;
  upstreamOriginKey: string;
  sourceClass: string;
}): Promise<SourceRow> {
  await pool.query(
    `INSERT INTO source_definitions(
       source_key,display_name,provider_name,upstream_origin_key,source_class,observation_basis,
       authority_type,collection_mode,default_poll_interval_seconds,minimum_poll_interval_seconds,
       supports_historical_retrieval,recovery_strategy,requires_auth,adapter_version,semantic_contract_version,
       license_class,commercial_use_status,redistribution_status,represents,does_not_represent,
       enabled_by_default,enabled
     ) VALUES ($1,$1,'BAYKUSH TEST',$2,$3,'OBSERVED','internal-test','POLL',3600,60,false,'LIVE_ONLY',false,
               'node7-test-adapter-v1','node7-test-semantics-v1','INTERNAL_TEST','NOT_APPLICABLE','NOT_APPLICABLE',
               'Deterministic NODE-7 PostgreSQL acceptance observation.',
               'Real-world attack, attribution, maliciousness, victim activity or production source independence.',false,false)
     ON CONFLICT (source_key) DO NOTHING`,
    [input.sourceKey, input.upstreamOriginKey, input.sourceClass],
  );
  const result = await pool.query<SourceRow>(
    `SELECT id,source_key,upstream_origin_key,source_class,observation_basis,adapter_version,
            semantic_contract_version,represents,does_not_represent
     FROM source_definitions WHERE source_key=$1`,
    [input.sourceKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Missing test source ${input.sourceKey}`);
  return row;
}

async function insertObservation(input: {
  source: SourceRow;
  entityKey: string;
  sourceRecordId: string;
  observedTime?: string;
  observedDate?: string;
  acquisitionBasis?: string;
}) {
  const runId = randomUUID();
  const workId = randomUUID();
  await pool.query(
    `INSERT INTO collection_runs(
       id,source_definition_id,trigger,purpose,state,idempotency_key,created_at,started_at,finished_at,available_at
     ) VALUES ($1,$2,'TEST','LIVE_INCREMENTAL','SUCCEEDED',$3,now(),now(),now(),now())`,
    [runId, input.source.id, sha({ runId, sourceKey: input.source.source_key, sourceRecordId: input.sourceRecordId })],
  );
  await pool.query(
    `INSERT INTO collection_work_units(
       id,run_id,ordinal,work_key,descriptor,state,created_at,started_at,finished_at,available_at
     ) VALUES ($1,$2,0,'node7-test','{}'::jsonb,'SUCCEEDED',now(),now(),now(),now())`,
    [workId, runId],
  );
  const payload = { node7Acceptance: true, entityKey: input.entityKey, sourceRecordId: input.sourceRecordId };
  const raw = await pool.query<{ id: string }>(
    `INSERT INTO raw_source_records(
       source_definition_id,collection_run_id,collection_work_unit_id,source_record_id,payload_sha256,payload,
       received_at,adapter_version,source_schema_version
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now(),$7,'node7-test-v1') RETURNING id`,
    [input.source.id, runId, workId, input.sourceRecordId, sha(payload), JSON.stringify(payload), input.source.adapter_version],
  );
  const rawId = raw.rows[0]?.id;
  if (!rawId) throw new Error("raw insert failed");

  const entities = [{ kind: "CVE", key: input.entityKey, label: input.entityKey }];
  const canonical = await pool.query<{ id: string }>(
    `INSERT INTO canonical_evidence_records(
       raw_record_id,source_definition_id,source_record_id,upstream_origin_key,canonical_key,record_kind,
       received_at,entities,facts,reference_urls,semantic_boundary,adapter_version,normalization_version,
       semantic_contract_version,normalized_sha256
     ) VALUES ($1,$2,$3,$4,$5,'VULNERABILITY_RECORD',now(),$6::jsonb,'[]'::jsonb,'[]'::jsonb,$7::jsonb,
               $8,'node7-test-normalization-v1',$9,$10) RETURNING id`,
    [
      rawId,
      input.source.id,
      input.sourceRecordId,
      input.source.upstream_origin_key,
      `cve:${input.entityKey}`,
      JSON.stringify(entities),
      JSON.stringify({ represents: input.source.represents, doesNotRepresent: input.source.does_not_represent }),
      input.source.adapter_version,
      input.source.semantic_contract_version,
      sha({ entities, source: input.source.source_key, record: input.sourceRecordId }),
    ],
  );
  const canonicalId = canonical.rows[0]?.id;
  if (!canonicalId) throw new Error("canonical insert failed");

  const observationKey = sha({
    sourceKey: input.source.source_key,
    sourceRecordId: input.sourceRecordId,
    entityType: "CVE",
    entityKey: input.entityKey,
    role: "PRIMARY",
  });
  const observedTime = input.observedTime ?? null;
  const observedDate = input.observedDate ?? null;
  assert.equal(Number(observedTime !== null) + Number(observedDate !== null), 1);
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO entity_observation_revisions(
       observation_key,revision_number,state,entity_key,entity_type,entity_role,source_definition_id,
       source_record_id,canonical_record_id,raw_record_id,observed_time,observed_date,time_precision,
       observation_basis,acquisition_basis,input_fingerprint
     ) VALUES ($1,1,'ACTIVE',$2,'CVE','PRIMARY',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [
      observationKey,
      input.entityKey,
      input.source.id,
      input.sourceRecordId,
      canonicalId,
      rawId,
      observedTime,
      observedDate,
      observedTime ? "INSTANT" : "DATE",
      input.source.observation_basis,
      input.acquisitionBasis ?? "LIVE_INCREMENTAL",
      sha({ observationKey, observedTime, observedDate }),
    ],
  );
  const revisionId = revision.rows[0]?.id;
  if (!revisionId) throw new Error("observation insert failed");
  await pool.query(
    `INSERT INTO entity_observation_heads(
       observation_key,current_revision_id,state,entity_key,entity_type,entity_role,source_definition_id,
       observed_time,observed_date,acquisition_basis,updated_at
     ) VALUES ($1,$2,'ACTIVE',$3,'CVE','PRIMARY',$4,$5,$6,$7,now())`,
    [observationKey, revisionId, input.entityKey, input.source.id, observedTime, observedDate, input.acquisitionBasis ?? "LIVE_INCREMENTAL"],
  );
  return { observationKey, revisionId, canonicalId, rawId };
}

async function insertHistory(input: {
  entityKey: string;
  source: SourceRow;
  firstSeenTime?: string;
  firstSeenDate?: string;
  basis: string;
}) {
  const firstTime = input.firstSeenTime ?? null;
  const firstDate = input.firstSeenDate ?? null;
  assert.equal(Number(firstTime !== null) + Number(firstDate !== null), 1);
  const fingerprint = sha({ entityKey: input.entityKey, firstTime, firstDate, basis: input.basis });
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO entity_history_revisions(
       entity_key,entity_type,revision_number,first_seen_time,first_seen_date,last_seen_time,last_seen_date,
       first_source_definition_id,last_source_definition_id,observation_count,source_count,
       revision_acquisition_basis,input_fingerprint
     ) VALUES ($1,'CVE',1,$2,$3,$2,$3,$4,$4,1,1,$5,$6) RETURNING id`,
    [input.entityKey, firstTime, firstDate, input.source.id, input.basis, fingerprint],
  );
  const id = revision.rows[0]?.id;
  if (!id) throw new Error("history insert failed");
  await pool.query(
    `INSERT INTO entity_history_heads(
       entity_key,entity_type,current_revision_id,first_seen_time,first_seen_date,last_seen_time,last_seen_date,
       first_source_definition_id,last_source_definition_id,observation_count,source_count,
       revision_acquisition_basis,updated_at
     ) VALUES ($1,'CVE',$2,$3,$4,$3,$4,$5,$5,1,1,$6,now())`,
    [input.entityKey, id, firstTime, firstDate, input.source.id, input.basis],
  );
  return id;
}

async function retractObservation(observationKey: string): Promise<void> {
  const result = await pool.query<RetractionRow>(
    `SELECT head.current_revision_id,head.entity_key,head.entity_type,head.entity_role,head.source_definition_id,
            revision.revision_number,revision.source_record_id,revision.canonical_record_id,revision.raw_record_id,
            revision.observed_time,revision.observed_date::text,revision.time_precision,revision.observation_basis,
            revision.input_fingerprint
     FROM entity_observation_heads head
     JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
     WHERE head.observation_key=$1`,
    [observationKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error("observation head missing");
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO entity_observation_revisions(
       observation_key,revision_number,state,entity_key,entity_type,entity_role,source_definition_id,
       source_record_id,canonical_record_id,raw_record_id,observed_time,observed_date,time_precision,
       observation_basis,acquisition_basis,input_fingerprint,supersedes_id
     ) VALUES ($1,$2,'RETRACTED',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'REPAIR',$14,$15) RETURNING id`,
    [
      observationKey,
      row.revision_number + 1,
      row.entity_key,
      row.entity_type,
      row.entity_role,
      row.source_definition_id,
      row.source_record_id,
      row.canonical_record_id,
      row.raw_record_id,
      row.observed_time,
      row.observed_date,
      row.time_precision,
      row.observation_basis,
      sha({ previous: row.input_fingerprint, retracted: true }),
      row.current_revision_id,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new Error("retraction insert failed");
  await pool.query(
    `UPDATE entity_observation_heads
     SET current_revision_id=$2,state='RETRACTED',acquisition_basis='REPAIR',updated_at=now()
     WHERE observation_key=$1`,
    [observationKey, id],
  );
}

async function drain(workerId: string): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const activity = await processNode7ActivityBatch({ workerId, queueLimit: 1_000, processLimit: 1_000 });
    const convergence = await processNode7ConvergenceBatch({ workerId, queueLimit: 1_000, processLimit: 1_000 });
    const discovery = await processNode7DiscoveryBatch({ workerId, queueLimit: 1_000, processLimit: 1_000 });
    if (activity.queued + activity.processed + convergence.queued + convergence.processed + discovery.queued + discovery.processed === 0) return;
  }
  throw new Error("NODE-7 acceptance did not drain within bounded rounds");
}

async function apiAcceptance(entityKey: string): Promise<void> {
  const token = "node7-acceptance-token-0123456789-abcdef";
  const server = createApiServer({ apiToken: token });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const unauth = await fetch(`${base}/v1/techint/discovery?range=30D`);
    assert.equal(unauth.status, 401);
    const headers = { authorization: `Bearer ${token}` };

    const discovery = await fetch(`${base}/v1/techint/discovery?range=30D`, { headers });
    assert.equal(discovery.status, 200);
    const discoveryJson = await discovery.json() as ApiEnvelopeRecord;
    assert.equal(discoveryJson.apiVersion, "v1");
    assert.equal("threatScore" in discoveryJson.data, false);

    const convergence = await fetch(`${base}/v1/techint/convergence?range=30D&limit=100`, { headers });
    assert.equal(convergence.status, 200);
    const convergenceJson = await convergence.json() as ApiEnvelopeList;
    assert.ok(Array.isArray(convergenceJson.data));

    const related = await fetch(
      `${base}/v1/techint/entities/${encodeURIComponent(entityKey)}/related-records?entityType=CVE&limit=50`,
      { headers },
    );
    assert.equal(related.status, 200);
    const relatedJson = await related.json() as RelatedEnvelope;
    assert.equal(relatedJson.data.relationshipBasis, "EXACT_CANONICAL_ENTITY_OVERLAP");
    assert.ok(relatedJson.data.records.length >= 2);

    const lineage = await fetch(
      `${base}/v1/techint/entities/${encodeURIComponent(entityKey)}/lineage?entityType=CVE&depth=3&limit=100`,
      { headers },
    );
    assert.equal(lineage.status, 200);
    const lineageJson = await lineage.json() as LineageEnvelope;
    assert.ok(lineageJson.data.nodes.length > 0);
    assert.ok(lineageJson.data.nodes.every((node) => !Object.prototype.hasOwnProperty.call(node.data, "payload")));

    const unbounded = await fetch(
      `${base}/v1/techint/entities/${encodeURIComponent(entityKey)}/lineage?entityType=CVE&depth=99&limit=100`,
      { headers },
    );
    assert.equal(unbounded.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function main(): Promise<void> {
  const workerId = `node7-acceptance-${process.pid}`;
  const sharedA = await ensureTestSource({
    sourceKey: "NODE7_TEST_SHARED_A",
    upstreamOriginKey: "NODE7_SHARED_ORIGIN",
    sourceClass: "OFFICIAL_ADVISORY",
  });
  const sharedB = await ensureTestSource({
    sourceKey: "NODE7_TEST_SHARED_B",
    upstreamOriginKey: "NODE7_SHARED_ORIGIN",
    sourceClass: "CERT_CSIRT_REPORTING",
  });
  const distinct = await ensureTestSource({
    sourceKey: "NODE7_TEST_DISTINCT",
    upstreamOriginKey: "NODE7_DISTINCT_ORIGIN",
    sourceClass: "VULNERABILITY_DATABASE",
  });

  const now = new Date();
  now.setUTCMinutes(10, 0, 0);
  const later = new Date(now.getTime() + 20 * 60 * 1_000);

  await insertObservation({ source: sharedA, entityKey: "CVE-2099-7001", sourceRecordId: "same-a", observedTime: now.toISOString() });
  await insertObservation({ source: sharedB, entityKey: "CVE-2099-7001", sourceRecordId: "same-b", observedTime: later.toISOString() });
  await insertObservation({ source: sharedA, entityKey: "CVE-2099-7002", sourceRecordId: "multi-a", observedTime: now.toISOString() });
  const multiB = await insertObservation({ source: distinct, entityKey: "CVE-2099-7002", sourceRecordId: "multi-b", observedTime: later.toISOString() });

  const date = now.toISOString().slice(0, 10);
  await insertObservation({ source: sharedA, entityKey: "CVE-2099-7003", sourceRecordId: "date-a", observedDate: date });
  await insertObservation({ source: distinct, entityKey: "CVE-2099-7003", sourceRecordId: "date-b", observedDate: date });

  const previousHour = new Date(now.getTime() - 60 * 60 * 1_000);
  const currentHour = new Date(now.getTime() + 5 * 60 * 1_000);
  await insertObservation({ source: sharedA, entityKey: "CVE-2099-7004", sourceRecordId: "composition-old", observedTime: previousHour.toISOString() });
  await insertObservation({ source: sharedA, entityKey: "CVE-2099-7004", sourceRecordId: "composition-current-a", observedTime: currentHour.toISOString() });
  await insertObservation({ source: distinct, entityKey: "CVE-2099-7004", sourceRecordId: "composition-current-b", observedTime: new Date(currentHour.getTime() + 5 * 60 * 1_000).toISOString() });

  await insertHistory({ entityKey: "CVE-2099-7010", source: sharedA, firstSeenTime: now.toISOString(), basis: "LIVE_INCREMENTAL" });
  await insertHistory({ entityKey: "CVE-2099-7011", source: sharedA, firstSeenDate: "2020-01-01", basis: "HISTORICAL_BACKFILL" });

  await drain(workerId);

  const same = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM convergence_finding_heads WHERE entity_key='CVE-2099-7001' AND state='ACTIVE'`,
  );
  const sameTypes = new Set(same.rows.map((row) => row.finding_type));
  assert.ok(sameTypes.has("SOURCE_SYSTEM_OVERLAP"));
  assert.ok(sameTypes.has("CROSS_CLASS_CONVERGENCE"));
  assert.equal(sameTypes.has("MULTI_ORIGIN_CONVERGENCE"), false);
  assert.equal(sameTypes.has("CONCURRENT_MOVEMENT"), false);

  const multi = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM convergence_finding_heads WHERE entity_key='CVE-2099-7002' AND state='ACTIVE'`,
  );
  const multiTypes = new Set(multi.rows.map((row) => row.finding_type));
  assert.ok(multiTypes.has("SOURCE_SYSTEM_OVERLAP"));
  assert.ok(multiTypes.has("MULTI_ORIGIN_CONVERGENCE"));
  assert.ok(multiTypes.has("CROSS_CLASS_CONVERGENCE"));
  assert.ok(multiTypes.has("CONCURRENT_MOVEMENT"));

  const dateResult = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM convergence_finding_heads WHERE entity_key='CVE-2099-7003' AND state='ACTIVE'`,
  );
  const dateTypes = new Set(dateResult.rows.map((row) => row.finding_type));
  assert.ok(dateTypes.has("MULTI_ORIGIN_CONVERGENCE"));
  assert.equal(dateTypes.has("CONCURRENT_MOVEMENT"), false);

  const novelty = await pool.query<{ entity_key: string; finding_type: string }>(
    `SELECT entity_key,finding_type FROM discovery_finding_heads
     WHERE entity_key IN ('CVE-2099-7010','CVE-2099-7011') AND state='ACTIVE'`,
  );
  assert.equal(novelty.rows.find((row) => row.entity_key === "CVE-2099-7010")?.finding_type, "NEW_ENTITY");
  assert.equal(novelty.rows.find((row) => row.entity_key === "CVE-2099-7011")?.finding_type, "HISTORICAL_DISCOVERY");

  const composition = await pool.query<{
    new_upstream_origin_count: number;
    new_source_definition_count: number;
  }>(
    `SELECT revision.new_upstream_origin_count,revision.new_source_definition_count
     FROM discovery_finding_heads head
     JOIN discovery_finding_revisions revision ON revision.id=head.current_revision_id
     WHERE head.entity_key='CVE-2099-7004' AND head.finding_type='COMPOSITION_EXPANSION' AND head.state='ACTIVE'
     ORDER BY head.window_start DESC LIMIT 1`,
  );
  assert.ok(composition.rows[0]);
  assert.ok((composition.rows[0]?.new_upstream_origin_count ?? 0) >= 1);
  assert.ok((composition.rows[0]?.new_source_definition_count ?? 0) >= 1);

  const beforeReplay = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM convergence_finding_revisions WHERE entity_key='CVE-2099-7002'`,
  );
  await drain(workerId);
  const afterReplay = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM convergence_finding_revisions WHERE entity_key='CVE-2099-7002'`,
  );
  assert.equal(afterReplay.rows[0]?.count, beforeReplay.rows[0]?.count);

  await retractObservation(multiB.observationKey);
  await drain(workerId);
  const afterRetraction = await pool.query<{ state: string }>(
    `SELECT state FROM convergence_finding_heads WHERE entity_key='CVE-2099-7002'`,
  );
  assert.ok(afterRetraction.rows.every((row) => row.state === "RETRACTED"));

  await apiAcceptance("CVE-2099-7001");
  console.log(JSON.stringify({
    schemaVersion: "NODE7_POSTGRES_ACCEPTANCE_V1",
    accepted: true,
    sameUpstream: { sourceSystemOverlap: true, multiOrigin: false },
    multiOrigin: { sourceSystemOverlap: true, multiOrigin: true, crossClass: true, concurrent: true },
    datePrecision: { multiOrigin: true, concurrent: false },
    novelty: { current: "NEW_ENTITY", historical: "HISTORICAL_DISCOVERY" },
    compositionExpansion: true,
    replayIdempotent: true,
    retractionRecomputed: true,
    api: { authBoundary: true, controlledBounds: true, relatedRecords: true, lineageNoRawPayload: true },
  }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

async function ensureSource(input: {
  sourceKey: string;
  upstreamOriginKey: string;
  sourceClass: string;
  observationBasis: "OBSERVED" | "REPORTED" | "PUBLISHED" | "SCORED" | "ENRICHED" | "UNKNOWN";
}): Promise<SourceRow> {
  await pool.query(
    `INSERT INTO source_definitions(
       source_key,display_name,provider_name,upstream_origin_key,source_class,observation_basis,
       authority_type,collection_mode,default_poll_interval_seconds,minimum_poll_interval_seconds,
       supports_historical_retrieval,recovery_strategy,requires_auth,adapter_version,semantic_contract_version,
       license_class,commercial_use_status,redistribution_status,represents,does_not_represent,
       enabled_by_default,enabled
     ) VALUES ($1,$1,'BAYKUSH TEST',$2,$3,$4,'internal-test','POLL',3600,60,false,'LIVE_ONLY',false,
               'node7-hardening-test-v1','node7-hardening-semantics-v1','INTERNAL_TEST','NOT_APPLICABLE','NOT_APPLICABLE',
               'Deterministic NODE-7 semantic-hardening acceptance input.',
               'Real-world attack, attribution, maliciousness, victim activity or source independence.',false,false)
     ON CONFLICT (source_key) DO NOTHING`,
    [input.sourceKey, input.upstreamOriginKey, input.sourceClass, input.observationBasis],
  );
  const result = await pool.query<SourceRow>(
    `SELECT id,source_key,upstream_origin_key,source_class,observation_basis,adapter_version,
            semantic_contract_version,represents,does_not_represent
     FROM source_definitions WHERE source_key=$1`,
    [input.sourceKey],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Missing NODE-7 hardening source ${input.sourceKey}`);
  return row;
}

async function insertObservation(input: {
  source: SourceRow;
  entityKey: string;
  sourceRecordId: string;
  observedTime: string;
}): Promise<void> {
  const runId = randomUUID();
  const workId = randomUUID();
  await pool.query(
    `INSERT INTO collection_runs(
       id,source_definition_id,trigger,purpose,state,idempotency_key,created_at,started_at,finished_at,available_at
     ) VALUES ($1,$2,'TEST','LIVE_INCREMENTAL','SUCCEEDED',$3,now(),now(),now(),now())`,
    [runId, input.source.id, sha({ runId, source: input.source.source_key, record: input.sourceRecordId })],
  );
  await pool.query(
    `INSERT INTO collection_work_units(
       id,run_id,ordinal,work_key,descriptor,state,created_at,started_at,finished_at,available_at
     ) VALUES ($1,$2,0,'node7-hardening','{}'::jsonb,'SUCCEEDED',now(),now(),now(),now())`,
    [workId, runId],
  );

  const payload = {
    node7SemanticHardening: true,
    entityKey: input.entityKey,
    sourceRecordId: input.sourceRecordId,
  };
  const raw = await pool.query<{ id: string }>(
    `INSERT INTO raw_source_records(
       source_definition_id,collection_run_id,collection_work_unit_id,source_record_id,payload_sha256,payload,
       received_at,adapter_version,source_schema_version
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,now(),$7,'node7-hardening-v1') RETURNING id`,
    [
      input.source.id,
      runId,
      workId,
      input.sourceRecordId,
      sha(payload),
      JSON.stringify(payload),
      input.source.adapter_version,
    ],
  );
  const rawId = raw.rows[0]?.id;
  if (!rawId) throw new Error("NODE-7 hardening raw insert failed");

  const entities = [{ kind: "CVE", key: input.entityKey, label: input.entityKey }];
  const canonical = await pool.query<{ id: string }>(
    `INSERT INTO canonical_evidence_records(
       raw_record_id,source_definition_id,source_record_id,upstream_origin_key,canonical_key,record_kind,
       received_at,entities,facts,reference_urls,semantic_boundary,adapter_version,normalization_version,
       semantic_contract_version,normalized_sha256
     ) VALUES ($1,$2,$3,$4,$5,'VULNERABILITY_RECORD',now(),$6::jsonb,'[]'::jsonb,'[]'::jsonb,$7::jsonb,
               $8,'node7-hardening-normalization-v1',$9,$10) RETURNING id`,
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
  if (!canonicalId) throw new Error("NODE-7 hardening canonical insert failed");

  const observationKey = sha({
    sourceKey: input.source.source_key,
    sourceRecordId: input.sourceRecordId,
    entityType: "CVE",
    entityKey: input.entityKey,
    role: "PRIMARY",
  });
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO entity_observation_revisions(
       observation_key,revision_number,state,entity_key,entity_type,entity_role,source_definition_id,
       source_record_id,canonical_record_id,raw_record_id,observed_time,time_precision,
       observation_basis,acquisition_basis,input_fingerprint
     ) VALUES ($1,1,'ACTIVE',$2,'CVE','PRIMARY',$3,$4,$5,$6,$7,'INSTANT',$8,'LIVE_INCREMENTAL',$9)
     RETURNING id`,
    [
      observationKey,
      input.entityKey,
      input.source.id,
      input.sourceRecordId,
      canonicalId,
      rawId,
      input.observedTime,
      input.source.observation_basis,
      sha({ observationKey, observedTime: input.observedTime }),
    ],
  );
  const revisionId = revision.rows[0]?.id;
  if (!revisionId) throw new Error("NODE-7 hardening observation insert failed");
  await pool.query(
    `INSERT INTO entity_observation_heads(
       observation_key,current_revision_id,state,entity_key,entity_type,entity_role,source_definition_id,
       observed_time,acquisition_basis,updated_at
     ) VALUES ($1,$2,'ACTIVE',$3,'CVE','PRIMARY',$4,$5,'LIVE_INCREMENTAL',now())`,
    [observationKey, revisionId, input.entityKey, input.source.id, input.observedTime],
  );
}

async function insertHistory(input: {
  entityKey: string;
  source: SourceRow;
  basis: "RESYNC" | "REPAIR";
  firstSeenTime: string;
}): Promise<void> {
  const fingerprint = sha(input);
  const revision = await pool.query<{ id: string }>(
    `INSERT INTO entity_history_revisions(
       entity_key,entity_type,revision_number,first_seen_time,last_seen_time,
       first_source_definition_id,last_source_definition_id,observation_count,source_count,
       revision_acquisition_basis,input_fingerprint
     ) VALUES ($1,'CVE',1,$2,$2,$3,$3,1,1,$4,$5) RETURNING id`,
    [input.entityKey, input.firstSeenTime, input.source.id, input.basis, fingerprint],
  );
  const id = revision.rows[0]?.id;
  if (!id) throw new Error("NODE-7 hardening history insert failed");
  await pool.query(
    `INSERT INTO entity_history_heads(
       entity_key,entity_type,current_revision_id,first_seen_time,last_seen_time,
       first_source_definition_id,last_source_definition_id,observation_count,source_count,
       revision_acquisition_basis,updated_at
     ) VALUES ($1,'CVE',$2,$3,$3,$4,$4,1,1,$5,now())`,
    [input.entityKey, id, input.firstSeenTime, input.source.id, input.basis],
  );
}

async function drain(workerId: string): Promise<void> {
  for (let round = 0; round < 20; round += 1) {
    const activity = await processNode7ActivityBatch({ workerId, queueLimit: 1_000, processLimit: 1_000 });
    const convergence = await processNode7ConvergenceBatch({ workerId, queueLimit: 1_000, processLimit: 1_000 });
    const discovery = await processNode7DiscoveryBatch({ workerId, queueLimit: 1_000, processLimit: 1_000 });
    if (activity.queued + activity.processed + convergence.queued + convergence.processed + discovery.queued + discovery.processed === 0) return;
  }
  throw new Error("NODE-7 semantic-hardening acceptance did not drain within bounded rounds");
}

async function main(): Promise<void> {
  const workerId = `node7-hardening-${process.pid}`;
  const contributor = await ensureSource({
    sourceKey: "NODE7_HARDENING_OBSERVED",
    upstreamOriginKey: "NODE7_HARDENING_ORIGIN_A",
    sourceClass: "OFFICIAL_ADVISORY",
    observationBasis: "OBSERVED",
  });
  const scoredContext = await ensureSource({
    sourceKey: "NODE7_HARDENING_SCORE",
    upstreamOriginKey: "NODE7_HARDENING_SCORE_ORIGIN",
    sourceClass: "EXPLOIT_PROBABILITY",
    observationBasis: "SCORED",
  });
  const enrichedDatabase = await ensureSource({
    sourceKey: "NODE7_HARDENING_ENRICHED_DB",
    upstreamOriginKey: "NODE7_HARDENING_ORIGIN_B",
    sourceClass: "VULNERABILITY_DATABASE",
    observationBasis: "ENRICHED",
  });
  const publishedCatalog = await ensureSource({
    sourceKey: "NODE7_HARDENING_PUBLISHED_CATALOG",
    upstreamOriginKey: "NODE7_HARDENING_ORIGIN_C",
    sourceClass: "EXPLOITED_VULNERABILITY_CATALOG",
    observationBasis: "PUBLISHED",
  });

  const now = new Date();
  now.setUTCMinutes(15, 0, 0);
  const later = new Date(now.getTime() + 10 * 60 * 1_000);

  await insertObservation({
    source: contributor,
    entityKey: "CVE-2099-7020",
    sourceRecordId: "context-gate-observed",
    observedTime: now.toISOString(),
  });
  await insertObservation({
    source: scoredContext,
    entityKey: "CVE-2099-7020",
    sourceRecordId: "context-gate-score",
    observedTime: later.toISOString(),
  });

  await insertObservation({
    source: enrichedDatabase,
    entityKey: "CVE-2099-7021",
    sourceRecordId: "enriched-real-source",
    observedTime: now.toISOString(),
  });
  await insertObservation({
    source: publishedCatalog,
    entityKey: "CVE-2099-7021",
    sourceRecordId: "published-real-source",
    observedTime: later.toISOString(),
  });

  await insertHistory({
    entityKey: "CVE-2099-7030",
    source: contributor,
    basis: "REPAIR",
    firstSeenTime: now.toISOString(),
  });
  await insertHistory({
    entityKey: "CVE-2099-7031",
    source: contributor,
    basis: "RESYNC",
    firstSeenTime: later.toISOString(),
  });

  await drain(workerId);

  const contextBucket = await pool.query<{
    observation_count: number;
    source_definition_count: number;
    upstream_origin_count: number;
  }>(
    `SELECT revision.observation_count,revision.source_definition_count,revision.upstream_origin_count
     FROM entity_activity_bucket_heads head
     JOIN entity_activity_bucket_revisions revision ON revision.id=head.current_revision_id
     WHERE head.entity_type='CVE' AND head.entity_key='CVE-2099-7020' AND head.resolution='HOUR'
     ORDER BY head.bucket_start DESC LIMIT 1`,
  );
  assert.deepEqual(contextBucket.rows[0], {
    observation_count: 1,
    source_definition_count: 1,
    upstream_origin_count: 1,
  });

  const contextMembers = await pool.query<{ source_key: string }>(
    `SELECT member.source_key
     FROM entity_activity_bucket_heads head
     JOIN entity_activity_bucket_members member ON member.bucket_revision_id=head.current_revision_id
     WHERE head.entity_type='CVE' AND head.entity_key='CVE-2099-7020' AND head.resolution='HOUR'`,
  );
  assert.deepEqual(contextMembers.rows.map((row) => row.source_key), ["NODE7_HARDENING_OBSERVED"]);

  const contextFindings = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM convergence_finding_heads
     WHERE entity_type='CVE' AND entity_key='CVE-2099-7020' AND state='ACTIVE'`,
  );
  assert.equal(contextFindings.rows.length, 0);

  const enrichedFindings = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM convergence_finding_heads
     WHERE entity_type='CVE' AND entity_key='CVE-2099-7021' AND state='ACTIVE'`,
  );
  const enrichedTypes = new Set(enrichedFindings.rows.map((row) => row.finding_type));
  assert.ok(enrichedTypes.has("SOURCE_SYSTEM_OVERLAP"));
  assert.ok(enrichedTypes.has("MULTI_ORIGIN_CONVERGENCE"));
  assert.ok(enrichedTypes.has("CROSS_CLASS_CONVERGENCE"));
  assert.ok(enrichedTypes.has("CONCURRENT_MOVEMENT"));

  const repairedNovelty = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM discovery_finding_heads
     WHERE entity_type='CVE' AND entity_key='CVE-2099-7030' AND state='ACTIVE'`,
  );
  const resyncNovelty = await pool.query<{ finding_type: string }>(
    `SELECT finding_type FROM discovery_finding_heads
     WHERE entity_type='CVE' AND entity_key='CVE-2099-7031' AND state='ACTIVE'`,
  );
  assert.equal(repairedNovelty.rows[0]?.finding_type, "HISTORICAL_DISCOVERY");
  assert.equal(resyncNovelty.rows[0]?.finding_type, "HISTORICAL_DISCOVERY");

  const policies = await pool.query<{ policy_key: string; policy_version: string }>(
    `SELECT policy_key,policy_version FROM current_node7_derivation_policies
     WHERE policy_key IN ('CONVERGENCE','DISCOVERY') ORDER BY policy_key`,
  );
  assert.deepEqual(policies.rows, [
    { policy_key: "CONVERGENCE", policy_version: "node7-convergence-v2-context-gated" },
    { policy_key: "DISCOVERY", policy_version: "node7-discovery-v2-live-novelty" },
  ]);

  console.log(JSON.stringify({
    schemaVersion: "NODE7_SEMANTIC_HARDENING_ACCEPTANCE_V1",
    accepted: true,
    convergence: {
      scoredContextDidNotIncreaseBreadth: true,
      contextInputsExcludedFromActivityLineage: true,
      enrichedVulnerabilityDatabaseStillContributes: true,
      sameHourConcurrencyContract: true,
    },
    novelty: {
      liveIncrementalOnlyCurrent: true,
      repairIsHistorical: true,
      resyncIsHistorical: true,
    },
    activePolicies: Object.fromEntries(policies.rows.map((row) => [row.policy_key, row.policy_version])),
  }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}

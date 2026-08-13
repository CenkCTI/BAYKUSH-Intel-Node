import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { claimBackfillSegment, persistBackfillPage } from "../src/backfill/repository.js";
import { claimNextRun, enqueueDueRuns } from "../src/runtime/repository.js";
import { adapterRegistry } from "../src/sources/registry.js";
import { syncSourceDefinitions } from "../src/runtime/source-sync.js";

const sourceKey = "TEST_NODE4_BACKFILL";

async function main() {
  await syncSourceDefinitions([...adapterRegistry.values()]);
  await pool.query(`INSERT INTO source_definitions(source_key,display_name,provider_name,upstream_origin_key,source_class,observation_basis,authority_type,collection_mode,default_poll_interval_seconds,minimum_poll_interval_seconds,supports_historical_retrieval,recovery_strategy,historical_max_window_seconds,requires_auth,credential_kind,adapter_version,semantic_contract_version,license_class,commercial_use_status,redistribution_status,attribution_requirement,terms_reference,represents,does_not_represent,enabled_by_default,enabled)
    SELECT $1,'NODE-4 isolation fixture',provider_name,'NODE4_TEST',source_class,observation_basis,'INTERNAL_TEST',collection_mode,60,60,true,recovery_strategy,historical_max_window_seconds,false,null,adapter_version,semantic_contract_version,'INTERNAL_TEST','NOT_APPLICABLE','NOT_APPLICABLE',null,null,'Isolation fixture','Production truth',false,true FROM source_definitions WHERE source_key='NVD_CVE' ON CONFLICT(source_key) DO NOTHING`, [sourceKey]);
  const source = await pool.query<{ id: string }>("SELECT id FROM source_definitions WHERE source_key=$1", [sourceKey]);
  const sourceId = source.rows[0]?.id;
  assert.ok(sourceId);
  await pool.query("DELETE FROM collection_work_units WHERE run_id IN (SELECT id FROM collection_runs WHERE source_definition_id=$1)", [sourceId]);
  await pool.query("DELETE FROM collection_runs WHERE source_definition_id=$1", [sourceId]);
  await pool.query("DELETE FROM historical_backfill_segments WHERE source_definition_id=$1", [sourceId]);
  await pool.query("DELETE FROM historical_backfill_requests WHERE source_definition_id=$1", [sourceId]);
  await pool.query("DELETE FROM source_checkpoints WHERE source_definition_id=$1", [sourceId]);
  await pool.query(`INSERT INTO source_schedule_state(source_definition_id,next_due_at) VALUES($1,now()) ON CONFLICT(source_definition_id) DO UPDATE SET next_due_at=now()`, [sourceId]);
  await pool.query(`INSERT INTO source_health(source_definition_id) VALUES($1) ON CONFLICT(source_definition_id) DO NOTHING`, [sourceId]);
  await pool.query(`INSERT INTO source_checkpoints(source_definition_id,checkpoint_schema_version,checkpoint,revision)
    VALUES($1,'nvd-cve-checkpoint-v1','{"version":1,"completedThrough":"2026-08-13T00:00:00.000Z","activeWindow":null}',7)
    ON CONFLICT(source_definition_id) DO UPDATE SET checkpoint_schema_version=EXCLUDED.checkpoint_schema_version,checkpoint=EXCLUDED.checkpoint,revision=7`, [sourceId]);
  await pool.query("UPDATE source_definitions SET enabled=true WHERE id=$1", [sourceId]);
  await pool.query("UPDATE source_schedule_state SET next_due_at=now()-interval '1 second' WHERE source_definition_id=$1", [sourceId]);

  const request = await pool.query<{ id: string }>(`INSERT INTO historical_backfill_requests(source_definition_id,requested_from,requested_to,status,backfill_policy_version,segments_planned)
    VALUES($1,'2026-08-01','2026-08-02','QUEUED','NODE4_TEST_V1',1) RETURNING id`, [sourceId]);
  const segment = await pool.query<{ id: string }>(`INSERT INTO historical_backfill_segments(request_id,source_definition_id,segment_index,segment_kind,window_start,window_end)
    VALUES($1,$2,0,'INTERVAL','2026-08-01','2026-08-02') RETURNING id`, [request.rows[0]?.id, sourceId]);
  const historical = await pool.query<{ id: string }>(`INSERT INTO collection_runs(source_definition_id,trigger,purpose,state,idempotency_key,historical_backfill_segment_id)
    VALUES($1,'RECOVERY','HISTORICAL_BACKFILL','QUEUED',$2,$3) RETURNING id`, [sourceId, `node4-isolation-${Date.now()}`, segment.rows[0]?.id]);

  assert.equal(await claimNextRun("live-worker", 60), null, "normal worker must exclude historical runs");
  assert.equal(await enqueueDueRuns([sourceKey], 1), 1, "historical work must not block live scheduling");
  const live = await claimNextRun("live-worker", 60);
  assert.ok(live);
  assert.notEqual(live.id, historical.rows[0]?.id);
  assert.notEqual(live.purpose, "HISTORICAL_BACKFILL");
  await pool.query("UPDATE collection_runs SET state='CANCELLED',finished_at=now(),lease_owner=null,lease_expires_at=null WHERE id=$1", [live.id]);

  const before = await pool.query<{ checkpoint: string; revision: string }>("SELECT checkpoint::text,revision::text FROM source_checkpoints WHERE source_definition_id=$1", [sourceId]);
  const claimed = await claimBackfillSegment("backfill-a", 60);
  assert.equal(claimed?.id, segment.rows[0]?.id);
  const adapter = adapterRegistry.get("NVD_CVE");
  assert.ok(adapter && claimed);
  await persistBackfillPage({ segment: claimed, workerId: "backfill-a", adapter, records: [], checkpoint: { startIndex: 2000, expectedTotalResults: 3000, restartCount: 0, notBeforeRequestAt: null }, complete: false });
  await pool.query("UPDATE historical_backfill_segments SET state='RUNNING',lease_owner='dead-worker',lease_expires_at=now()-interval '1 second' WHERE id=$1", [claimed.id]);
  const reclaimed = await claimBackfillSegment("backfill-b", 60);
  assert.equal(reclaimed?.id, claimed.id, "expired NVD segment must be reclaimable");
  assert.deepEqual(reclaimed?.checkpoint, { startIndex: 2000, expectedTotalResults: 3000, restartCount: 0, notBeforeRequestAt: null });
  await persistBackfillPage({ segment: reclaimed!, workerId: "backfill-b", adapter, records: [], checkpoint: {}, complete: true });
  const after = await pool.query<{ checkpoint: string; revision: string }>("SELECT checkpoint::text,revision::text FROM source_checkpoints WHERE source_definition_id=$1", [sourceId]);
  assert.deepEqual(after.rows, before.rows, "historical execution must not mutate live checkpoint bytes or revision");
  console.log("NODE-4 live/backfill PostgreSQL isolation acceptance passed");
}

try { await main(); } finally { await pool.end(); }

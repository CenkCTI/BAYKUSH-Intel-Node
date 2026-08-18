import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../db/pool.js";
import { canonicalJsonStringify } from "../runtime/raw-record.js";
import { classifyNode7NoveltyBasis } from "./contracts.js";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

function dayWindow(value: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  return { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
}

interface PendingHistoryRow {
  history_revision_id: string;
  entity_type: string;
  entity_key: string;
  first_seen_time: Date | null;
  first_seen_date: string | null;
  calculated_at: Date;
  policy_revision_id: string;
}

interface PendingActivityRow {
  activity_revision_id: string;
  entity_type: string;
  entity_key: string;
  resolution: "HOUR" | "DAY";
  bucket_start: Date;
  bucket_end: Date;
  policy_revision_id: string;
}

export async function queuePendingDiscoveryJobs(limit = 500): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) throw new Error("Invalid NODE-7 discovery queue limit");
  const history = await pool.query<PendingHistoryRow>(
    `SELECT revision.id AS history_revision_id,revision.entity_type,revision.entity_key,
            revision.first_seen_time,revision.first_seen_date::text,revision.calculated_at,
            policy.current_revision_id AS policy_revision_id
     FROM entity_history_revisions revision
     JOIN node7_entity_capabilities capability
       ON capability.entity_type=revision.entity_type AND capability.novelty_enabled=true
     JOIN node7_derivation_policy_heads policy ON policy.policy_key='DISCOVERY'
     WHERE NOT EXISTS (
       SELECT 1 FROM discovery_history_projection_receipts receipt
       WHERE receipt.entity_history_revision_id=revision.id
         AND receipt.policy_revision_id=policy.current_revision_id
     )
     ORDER BY revision.calculated_at,revision.id LIMIT $1`,
    [limit],
  );

  const activity = await pool.query<PendingActivityRow>(
    `SELECT revision.id AS activity_revision_id,revision.entity_type,revision.entity_key,
            revision.resolution,revision.bucket_start,revision.bucket_end,
            policy.current_revision_id AS policy_revision_id
     FROM entity_activity_bucket_heads head
     JOIN entity_activity_bucket_revisions revision ON revision.id=head.current_revision_id
     JOIN node7_entity_capabilities capability
       ON capability.entity_type=revision.entity_type AND capability.composition_enabled=true
     JOIN node7_derivation_policy_heads policy ON policy.policy_key='DISCOVERY'
     WHERE NOT EXISTS (
       SELECT 1 FROM discovery_activity_projection_receipts receipt
       WHERE receipt.activity_bucket_revision_id=revision.id
         AND receipt.policy_revision_id=policy.current_revision_id
     )
     ORDER BY revision.calculated_at,revision.id LIMIT $1`,
    [limit],
  );

  let queued = 0;
  for (const row of history.rows) {
    const effective = row.first_seen_time
      ?? (row.first_seen_date ? new Date(`${row.first_seen_date}T00:00:00.000Z`) : row.calculated_at);
    const window = dayWindow(effective);
    const key = sha256({ projectionKind: "DISCOVERY", inputKind: "HISTORY", inputId: row.history_revision_id, policyRevisionId: row.policy_revision_id });
    const inserted = await pool.query(
      `INSERT INTO node7_projection_jobs(
         projection_kind,subject_type,subject_key,window_start,window_end,policy_revision_id,
         trigger_entity_history_revision_id,idempotency_key
       ) VALUES ('DISCOVERY',$1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [row.entity_type,row.entity_key,window.start,window.end,row.policy_revision_id,row.history_revision_id,key],
    );
    queued += inserted.rowCount ?? 0;
  }
  for (const row of activity.rows) {
    const key = sha256({ projectionKind: "DISCOVERY", inputKind: "ACTIVITY", inputId: row.activity_revision_id, policyRevisionId: row.policy_revision_id });
    const inserted = await pool.query(
      `INSERT INTO node7_projection_jobs(
         projection_kind,subject_type,subject_key,resolution,window_start,window_end,policy_revision_id,
         trigger_activity_bucket_revision_id,idempotency_key
       ) VALUES ('DISCOVERY',$1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [row.entity_type,row.entity_key,row.resolution,row.bucket_start.toISOString(),row.bucket_end.toISOString(),row.policy_revision_id,row.activity_revision_id,key],
    );
    queued += inserted.rowCount ?? 0;
  }
  return queued;
}

interface DiscoveryJobRow {
  id: string;
  subject_type: string;
  subject_key: string;
  resolution: "HOUR" | "DAY" | null;
  window_start: Date;
  window_end: Date;
  policy_revision_id: string;
  trigger_entity_history_revision_id: string | null;
  trigger_activity_bucket_revision_id: string | null;
}

async function claimDiscoveryJob(client: PoolClient, workerId: string): Promise<DiscoveryJobRow | null> {
  const result = await client.query<DiscoveryJobRow>(
    `WITH candidate AS (
       SELECT id FROM node7_projection_jobs
       WHERE projection_kind='DISCOVERY' AND state IN ('QUEUED','FAILED')
         AND available_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now())
       ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE node7_projection_jobs job
     SET state='RUNNING',lease_owner=$1,lease_expires_at=now()+interval '2 minutes',
         attempt_count=attempt_count+1,started_at=COALESCE(started_at,now()),updated_at=now(),
         failure_code=NULL,failure_message=NULL
     FROM candidate WHERE job.id=candidate.id
     RETURNING job.id,job.subject_type,job.subject_key,job.resolution,job.window_start,job.window_end,
               job.policy_revision_id,job.trigger_entity_history_revision_id,job.trigger_activity_bucket_revision_id`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

async function upsertDiscoveryHead(input: {
  client: PoolClient;
  findingKey: string;
  findingType: "NEW_ENTITY" | "HISTORICAL_DISCOVERY" | "COMPOSITION_EXPANSION";
  state: "ACTIVE" | "RETRACTED";
  entityType: string;
  entityKey: string;
  windowStart: string | null;
  windowEnd: string | null;
  effectiveFirstSeenTime: string | null;
  effectiveFirstSeenDate: string | null;
  timePrecision: "INSTANT" | "DATE" | null;
  nodeDiscoveredAt: string;
  newSourceDefinitionKeys: string[];
  newUpstreamOriginKeys: string[];
  newSourceClasses: string[];
  acquisitionBasis: string | null;
  policyRevisionId: string;
  inputFingerprint: string;
  historyRevisionId: string | null;
  currentActivityRevisionId: string | null;
  previousActivityRevisionId: string | null;
}): Promise<void> {
  const prior = await input.client.query<{ current_revision_id: string; revision_number: number; input_fingerprint: string }>(
    `SELECT head.current_revision_id,revision.revision_number,revision.input_fingerprint
     FROM discovery_finding_heads head JOIN discovery_finding_revisions revision ON revision.id=head.current_revision_id
     WHERE head.finding_key=$1 FOR UPDATE OF head`, [input.findingKey],
  );
  const previous = prior.rows[0];
  if (previous?.input_fingerprint === input.inputFingerprint) return;
  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO discovery_finding_revisions(
       finding_key,revision_number,state,finding_type,entity_type,entity_key,window_start,window_end,
       effective_first_seen_time,effective_first_seen_date,time_precision,node_discovered_at,
       new_source_definition_count,new_upstream_origin_count,new_source_class_count,
       new_source_definition_keys,new_upstream_origin_keys,new_source_classes,acquisition_basis,
       policy_revision_id,input_fingerprint,supersedes_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,$22)
     RETURNING id`,
    [
      input.findingKey,(previous?.revision_number ?? 0)+1,input.state,input.findingType,input.entityType,input.entityKey,
      input.windowStart,input.windowEnd,input.effectiveFirstSeenTime,input.effectiveFirstSeenDate,input.timePrecision,input.nodeDiscoveredAt,
      input.newSourceDefinitionKeys.length,input.newUpstreamOriginKeys.length,input.newSourceClasses.length,
      JSON.stringify(input.newSourceDefinitionKeys),JSON.stringify(input.newUpstreamOriginKeys),JSON.stringify(input.newSourceClasses),
      input.acquisitionBasis,input.policyRevisionId,input.inputFingerprint,previous?.current_revision_id ?? null,
    ],
  );
  const revisionId = inserted.rows[0]?.id;
  if (!revisionId) throw new Error("NODE-7 discovery revision insert failed");
  await input.client.query(
    `INSERT INTO discovery_finding_inputs(
       finding_revision_id,entity_history_revision_id,current_activity_bucket_revision_id,previous_activity_bucket_revision_id
     ) VALUES ($1,$2,$3,$4)`,
    [revisionId,input.historyRevisionId,input.currentActivityRevisionId,input.previousActivityRevisionId],
  );
  await input.client.query(
    `INSERT INTO discovery_finding_heads(
       finding_key,current_revision_id,state,finding_type,entity_type,entity_key,window_start,window_end,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
     ON CONFLICT (finding_key) DO UPDATE SET
       current_revision_id=EXCLUDED.current_revision_id,state=EXCLUDED.state,finding_type=EXCLUDED.finding_type,
       entity_type=EXCLUDED.entity_type,entity_key=EXCLUDED.entity_key,window_start=EXCLUDED.window_start,
       window_end=EXCLUDED.window_end,updated_at=now()`,
    [input.findingKey,revisionId,input.state,input.findingType,input.entityType,input.entityKey,input.windowStart,input.windowEnd],
  );
}

async function projectHistoryDiscovery(client: PoolClient, job: DiscoveryJobRow): Promise<void> {
  if (!job.trigger_entity_history_revision_id) return;
  const result = await client.query<{
    id: string;
    entity_type: string;
    entity_key: string;
    first_seen_time: Date | null;
    first_seen_date: string | null;
    revision_acquisition_basis: "LIVE_INCREMENTAL" | "INITIAL_BOOTSTRAP" | "RECOVERY" | "HISTORICAL_BACKFILL" | "RESYNC" | "REPAIR" | "SNAPSHOT_RECONSTRUCTION";
    input_fingerprint: string;
    calculated_at: Date;
  }>(`SELECT id,entity_type,entity_key,first_seen_time,first_seen_date::text,revision_acquisition_basis,input_fingerprint,calculated_at
      FROM entity_history_revisions WHERE id=$1`, [job.trigger_entity_history_revision_id]);
  const history = result.rows[0];
  if (!history) throw new Error("NODE-7 discovery history input missing");
  const classed = classifyNode7NoveltyBasis(history.revision_acquisition_basis);
  const findingType = classed === "CURRENT" ? "NEW_ENTITY" : "HISTORICAL_DISCOVERY";
  const findingKey = sha256({ kind: "NOVELTY", entityType: history.entity_type, entityKey: history.entity_key, policyRevisionId: job.policy_revision_id });
  const fingerprint = sha256({ historyRevisionId: history.id, findingType, policyRevisionId: job.policy_revision_id, historyFingerprint: history.input_fingerprint });
  await upsertDiscoveryHead({
    client,
    findingKey,
    findingType,
    state: "ACTIVE",
    entityType: history.entity_type,
    entityKey: history.entity_key,
    windowStart: null,
    windowEnd: null,
    effectiveFirstSeenTime: history.first_seen_time?.toISOString() ?? null,
    effectiveFirstSeenDate: history.first_seen_date,
    timePrecision: history.first_seen_time ? "INSTANT" : "DATE",
    nodeDiscoveredAt: history.calculated_at.toISOString(),
    newSourceDefinitionKeys: [],newUpstreamOriginKeys: [],newSourceClasses: [],
    acquisitionBasis: history.revision_acquisition_basis,
    policyRevisionId: job.policy_revision_id,
    inputFingerprint: fingerprint,
    historyRevisionId: history.id,
    currentActivityRevisionId: null,
    previousActivityRevisionId: null,
  });
  await client.query(
    `INSERT INTO discovery_history_projection_receipts(entity_history_revision_id,policy_revision_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`, [history.id,job.policy_revision_id],
  );
}

interface MemberRow { source_key: string; upstream_origin_key: string; source_class: string }

async function projectCompositionDiscovery(client: PoolClient, job: DiscoveryJobRow): Promise<void> {
  if (!job.trigger_activity_bucket_revision_id || !job.resolution) return;
  const currentResult = await client.query<{ id:string; state:"ACTIVE"|"EMPTY"; bucket_start:Date; bucket_end:Date }>(
    `SELECT id,state,bucket_start,bucket_end FROM entity_activity_bucket_revisions WHERE id=$1`, [job.trigger_activity_bucket_revision_id],
  );
  const current = currentResult.rows[0];
  if (!current) throw new Error("NODE-7 composition activity input missing");
  const previousStart = new Date(current.bucket_start.getTime() - (job.resolution === "HOUR" ? 3_600_000 : 86_400_000));
  const previous = await client.query<{ current_revision_id:string }>(
    `SELECT current_revision_id FROM entity_activity_bucket_heads
     WHERE entity_type=$1 AND entity_key=$2 AND resolution=$3 AND bucket_start=$4`,
    [job.subject_type,job.subject_key,job.resolution,previousStart.toISOString()],
  );
  const previousRevisionId = previous.rows[0]?.current_revision_id ?? null;
  const currentMembers = current.state === "ACTIVE"
    ? await client.query<MemberRow>(`SELECT source_key,upstream_origin_key,source_class FROM entity_activity_bucket_members WHERE bucket_revision_id=$1`, [current.id])
    : { rows: [] as MemberRow[] };
  const previousMembers = previousRevisionId
    ? await client.query<MemberRow>(`SELECT source_key,upstream_origin_key,source_class FROM entity_activity_bucket_members WHERE bucket_revision_id=$1`, [previousRevisionId])
    : { rows: [] as MemberRow[] };

  const priorSources = new Set(previousMembers.rows.map((row) => row.source_key));
  const priorOrigins = new Set(previousMembers.rows.map((row) => row.upstream_origin_key));
  const priorClasses = new Set(previousMembers.rows.map((row) => row.source_class));
  const newSources = [...new Set(currentMembers.rows.map((row) => row.source_key).filter((value) => !priorSources.has(value)))].sort();
  const newOrigins = [...new Set(currentMembers.rows.map((row) => row.upstream_origin_key).filter((value) => !priorOrigins.has(value)))].sort();
  const newClasses = [...new Set(currentMembers.rows.map((row) => row.source_class).filter((value) => !priorClasses.has(value)))].sort();
  const active = newSources.length + newOrigins.length + newClasses.length > 0;
  const findingKey = sha256({ kind:"COMPOSITION_EXPANSION",entityType:job.subject_type,entityKey:job.subject_key,resolution:job.resolution,windowStart:current.bucket_start.toISOString(),policyRevisionId:job.policy_revision_id });
  const fingerprint = sha256({ currentRevisionId:current.id,previousRevisionId,newSources,newOrigins,newClasses,state:active?"ACTIVE":"RETRACTED",policyRevisionId:job.policy_revision_id });
  const existing = await client.query<{ state:"ACTIVE"|"RETRACTED" }>(`SELECT state FROM discovery_finding_heads WHERE finding_key=$1`, [findingKey]);
  if (active || existing.rows[0]?.state === "ACTIVE") {
    await upsertDiscoveryHead({
      client,findingKey,findingType:"COMPOSITION_EXPANSION",state:active?"ACTIVE":"RETRACTED",
      entityType:job.subject_type,entityKey:job.subject_key,windowStart:current.bucket_start.toISOString(),windowEnd:current.bucket_end.toISOString(),
      effectiveFirstSeenTime:null,effectiveFirstSeenDate:null,timePrecision:null,nodeDiscoveredAt:new Date().toISOString(),
      newSourceDefinitionKeys:newSources,newUpstreamOriginKeys:newOrigins,newSourceClasses:newClasses,acquisitionBasis:null,
      policyRevisionId:job.policy_revision_id,inputFingerprint:fingerprint,historyRevisionId:null,
      currentActivityRevisionId:current.id,previousActivityRevisionId:previousRevisionId,
    });
  }
  await client.query(
    `INSERT INTO discovery_activity_projection_receipts(activity_bucket_revision_id,policy_revision_id)
     VALUES ($1,$2) ON CONFLICT DO NOTHING`, [current.id,job.policy_revision_id],
  );
}

export async function processNextDiscoveryJob(workerId:string):Promise<boolean>{
  if(!workerId.trim())throw new Error("NODE-7 discovery worker requires a worker id");
  return withTransaction(async(client)=>{
    const job=await claimDiscoveryJob(client,workerId);if(!job)return false;
    try{
      if(job.trigger_entity_history_revision_id)await projectHistoryDiscovery(client,job);
      if(job.trigger_activity_bucket_revision_id)await projectCompositionDiscovery(client,job);
      await client.query(`UPDATE node7_projection_jobs SET state='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,finished_at=now(),updated_at=now() WHERE id=$1`,[job.id]);
      return true;
    }catch(error){
      const message=error instanceof Error?error.message.slice(0,500):"Unknown NODE-7 discovery error";
      await client.query(`UPDATE node7_projection_jobs SET state='FAILED',lease_owner=NULL,lease_expires_at=NULL,available_at=now()+interval '30 seconds',failure_code='DISCOVERY_PROJECTION_FAILED',failure_message=$2,finished_at=now(),updated_at=now() WHERE id=$1`,[job.id,message]);
      return false;
    }
  });
}

export async function processNode7DiscoveryBatch(input:{workerId:string;queueLimit?:number;processLimit?:number}):Promise<{queued:number;processed:number}>{
  const queued=await queuePendingDiscoveryJobs(input.queueLimit??500);const processLimit=input.processLimit??100;
  if(!Number.isInteger(processLimit)||processLimit<1||processLimit>1_000)throw new Error("Invalid NODE-7 discovery process limit");
  let processed=0;for(let index=0;index<processLimit;index+=1){if(!(await processNextDiscoveryJob(input.workerId)))break;processed+=1;}
  return{queued,processed};
}

import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";
import { node7GeographyConfig } from "./config.js";
import { lookupIpinfoLite } from "./ipinfo-lite.js";

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}

interface PendingGeoSubjectRow {
  entity_type: string;
  entity_key: string;
  history_revision_id: string;
  policy_revision_id: string;
  provider_source_definition_id: string;
}

export async function queuePendingGeographyJobs(limit = 250): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("Invalid NODE-7 geography queue limit");
  const config = node7GeographyConfig();
  if (!config.ipinfoLiteToken) return 0;

  const result = await pool.query<PendingGeoSubjectRow>(
    `SELECT history.entity_type,history.entity_key,history.current_revision_id AS history_revision_id,
            policy.current_revision_id AS policy_revision_id,provider.source_definition_id AS provider_source_definition_id
     FROM entity_history_heads history
     JOIN node7_entity_capabilities capability
       ON capability.entity_type=history.entity_type AND capability.geography_enabled=true
     JOIN node7_derivation_policy_heads policy ON policy.policy_key='GEOGRAPHY'
     JOIN current_source_admissions provider ON provider.source_key='IPINFO_LITE'
     WHERE history.entity_type='IP'
       AND provider.admission_status IN ('ADMITTED','ACTIVE')
       AND provider.hash_valid=true
       AND provider.collection_allowed=true
       AND provider.derived_data_status='ALLOWED'
       AND provider.public_display_status IN ('ALLOWED','RESTRICTED')
       AND NOT EXISTS (
         SELECT 1 FROM geography_projection_receipts receipt
         WHERE receipt.subject_entity_type=history.entity_type
           AND receipt.subject_entity_key=history.entity_key
           AND receipt.provider_source_definition_id=provider.source_definition_id
           AND receipt.policy_revision_id=policy.current_revision_id
           AND receipt.looked_up_at > now()-make_interval(hours=>$2)
       )
     ORDER BY history.updated_at DESC,history.entity_key
     LIMIT $1`,
    [limit, config.refreshHours],
  );

  let queued = 0;
  const now = new Date();
  const end = new Date(now.getTime() + 60_000);
  const lookupDate = now.toISOString().slice(0, 10);
  for (const row of result.rows) {
    const idempotencyKey = sha256({
      projectionKind: "GEOGRAPHY",
      entityType: row.entity_type,
      entityKey: row.entity_key,
      historyRevisionId: row.history_revision_id,
      policyRevisionId: row.policy_revision_id,
      providerSourceDefinitionId: row.provider_source_definition_id,
      lookupDate,
    });
    const inserted = await pool.query(
      `INSERT INTO node7_projection_jobs(
         projection_kind,subject_type,subject_key,window_start,window_end,policy_revision_id,
         trigger_entity_history_revision_id,idempotency_key
       ) VALUES ('GEOGRAPHY',$1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [row.entity_type,row.entity_key,now.toISOString(),end.toISOString(),row.policy_revision_id,row.history_revision_id,idempotencyKey],
    );
    queued += inserted.rowCount ?? 0;
  }
  return queued;
}

interface GeographyJobRow {
  id: string;
  subject_type: string;
  subject_key: string;
  policy_revision_id: string;
  trigger_entity_history_revision_id: string;
}

async function claimGeographyJob(client: PoolClient, workerId: string): Promise<GeographyJobRow | null> {
  const result = await client.query<GeographyJobRow>(
    `WITH candidate AS (
       SELECT id FROM node7_projection_jobs
       WHERE projection_kind='GEOGRAPHY' AND state IN ('QUEUED','FAILED')
         AND available_at<=now() AND (lease_expires_at IS NULL OR lease_expires_at<now())
       ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE node7_projection_jobs job
     SET state='RUNNING',lease_owner=$1,lease_expires_at=now()+interval '2 minutes',
         attempt_count=attempt_count+1,started_at=COALESCE(started_at,now()),updated_at=now(),
         failure_code=NULL,failure_message=NULL
     FROM candidate WHERE job.id=candidate.id
     RETURNING job.id,job.subject_type,job.subject_key,job.policy_revision_id,job.trigger_entity_history_revision_id`,
    [workerId],
  );
  return result.rows[0] ?? null;
}

async function projectGeography(client: PoolClient, job: GeographyJobRow): Promise<void> {
  if (job.subject_type !== "IP") throw new Error("NODE-7 IPinfo geography job subject must be IP");
  const config = node7GeographyConfig();
  if (!config.ipinfoLiteToken) throw new Error("IPINFO_LITE_TOKEN is not configured");

  const provider = await client.query<{
    source_definition_id: string;
    attribution_requirement: string | null;
  }>(
    `SELECT source_definition_id,attribution_requirement
     FROM current_source_admissions
     WHERE source_key='IPINFO_LITE' AND admission_status IN ('ADMITTED','ACTIVE')
       AND hash_valid=true AND collection_allowed=true AND derived_data_status='ALLOWED'
     LIMIT 1`,
  );
  const providerRow = provider.rows[0];
  if (!providerRow) throw new Error("IPinfo Lite source admission is not active for NODE-7 geography");

  const result = await lookupIpinfoLite({
    ip: job.subject_key,
    token: config.ipinfoLiteToken,
    timeoutMs: config.httpTimeoutMs,
  });
  const lookupDate = result.lookedUpAt.slice(0, 10);

  let assertionRevisionId: string | null = null;
  if (result.countryCode && !result.bogon) {
    const assertionKey = sha256({
      entityType: job.subject_type,
      entityKey: job.subject_key,
      geoClass: "OBSERVED_INFRASTRUCTURE_LOCATION",
      basisSourceDefinitionId: providerRow.source_definition_id,
      policyRevisionId: job.policy_revision_id,
    });
    const prior = await client.query<{
      current_revision_id: string;
      revision_number: number;
      input_fingerprint: string;
    }>(
      `SELECT head.current_revision_id,revision.revision_number,revision.input_fingerprint
       FROM geographic_assertion_heads head
       JOIN geographic_assertion_revisions revision ON revision.id=head.current_revision_id
       WHERE head.assertion_key=$1 FOR UPDATE OF head`,
      [assertionKey],
    );
    const previous = prior.rows[0];
    const fingerprint = sha256({
      providerResponseSha256: result.responseSha256,
      lookedUpAt: result.lookedUpAt,
      historyRevisionId: job.trigger_entity_history_revision_id,
      policyRevisionId: job.policy_revision_id,
    });
    if (previous?.input_fingerprint === fingerprint) {
      assertionRevisionId = previous.current_revision_id;
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO geographic_assertion_revisions(
           assertion_key,revision_number,state,subject_entity_type,subject_entity_key,geo_class,
           country_code,country_name,continent_code,continent_name,location_precision,basis_type,
           basis_source_definition_id,observed_time,time_precision,valid_from,temporal_policy,
           quality_class,provider_context,policy_revision_id,input_fingerprint,supersedes_id
         ) VALUES ($1,$2,'ACTIVE',$3,$4,'OBSERVED_INFRASTRUCTURE_LOCATION',$5,$6,$7,$8,'COUNTRY',
                   'IP_GEO_PROVIDER_CURRENT_SNAPSHOT',$9,$10,'INSTANT',$10,'CURRENT_SNAPSHOT_ONLY',
                   'COUNTRY_LEVEL_PROVIDER_ASSERTION',$11::jsonb,$12,$13,$14)
         RETURNING id`,
        [
          assertionKey,(previous?.revision_number ?? 0)+1,job.subject_type,job.subject_key,
          result.countryCode,result.countryName,result.continentCode,result.continentName,
          providerRow.source_definition_id,result.lookedUpAt,
          JSON.stringify({
            asn: result.asn,
            asName: result.asName,
            asDomain: result.asDomain,
            anycast: result.anycast,
            attribution: providerRow.attribution_requirement ?? "IP address data powered by IPinfo",
            semanticBoundary: "ASN context is not physical location or attacker origin.",
          }),
          job.policy_revision_id,fingerprint,previous?.current_revision_id ?? null,
        ],
      );
      assertionRevisionId = inserted.rows[0]?.id ?? null;
      if (!assertionRevisionId) throw new Error("NODE-7 geographic assertion insert failed");
      await client.query(
        `INSERT INTO geographic_assertion_inputs(assertion_revision_id,entity_history_revision_id)
         VALUES ($1,$2)`, [assertionRevisionId,job.trigger_entity_history_revision_id],
      );
      await client.query(
        `INSERT INTO geographic_assertion_heads(
           assertion_key,current_revision_id,state,subject_entity_type,subject_entity_key,geo_class,
           basis_source_definition_id,observed_time,updated_at
         ) VALUES ($1,$2,'ACTIVE',$3,$4,'OBSERVED_INFRASTRUCTURE_LOCATION',$5,$6,now())
         ON CONFLICT (assertion_key) DO UPDATE SET
           current_revision_id=EXCLUDED.current_revision_id,state='ACTIVE',
           subject_entity_type=EXCLUDED.subject_entity_type,subject_entity_key=EXCLUDED.subject_entity_key,
           geo_class=EXCLUDED.geo_class,basis_source_definition_id=EXCLUDED.basis_source_definition_id,
           observed_time=EXCLUDED.observed_time,observed_date=NULL,updated_at=now()`,
        [assertionKey,assertionRevisionId,job.subject_type,job.subject_key,providerRow.source_definition_id,result.lookedUpAt],
      );
    }
  }

  await client.query(
    `INSERT INTO geography_projection_receipts(
       subject_entity_type,subject_entity_key,provider_source_definition_id,policy_revision_id,
       lookup_date,assertion_revision_id,looked_up_at,provider_response_sha256
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (subject_entity_type,subject_entity_key,provider_source_definition_id,policy_revision_id,lookup_date)
     DO UPDATE SET assertion_revision_id=EXCLUDED.assertion_revision_id,looked_up_at=EXCLUDED.looked_up_at,
                   provider_response_sha256=EXCLUDED.provider_response_sha256`,
    [job.subject_type,job.subject_key,providerRow.source_definition_id,job.policy_revision_id,lookupDate,assertionRevisionId,result.lookedUpAt,result.responseSha256],
  );
  await client.query(
    `UPDATE node7_projection_jobs SET state='SUCCEEDED',lease_owner=NULL,lease_expires_at=NULL,
       finished_at=now(),updated_at=now() WHERE id=$1`, [job.id],
  );
}

export async function processNextGeographyJob(workerId: string): Promise<boolean> {
  if (!workerId.trim()) throw new Error("NODE-7 geography worker requires worker id");
  return withTransaction(async (client) => {
    const job = await claimGeographyJob(client, workerId);
    if (!job) return false;
    try {
      await projectGeography(client, job);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Unknown NODE-7 geography error";
      await client.query(
        `UPDATE node7_projection_jobs SET state='FAILED',lease_owner=NULL,lease_expires_at=NULL,
         available_at=now()+interval '5 minutes',failure_code='GEOGRAPHY_PROJECTION_FAILED',
         failure_message=$2,finished_at=now(),updated_at=now() WHERE id=$1`, [job.id,message],
      );
      return false;
    }
  });
}

export async function processNode7GeographyBatch(input: { workerId: string; queueLimit?: number; processLimit?: number }): Promise<{ queued: number; processed: number }> {
  const queued = await queuePendingGeographyJobs(input.queueLimit ?? 250);
  const processLimit = input.processLimit ?? 25;
  if (!Number.isInteger(processLimit) || processLimit < 1 || processLimit > 100) throw new Error("Invalid NODE-7 geography process limit");
  let processed = 0;
  for (let index=0; index<processLimit; index+=1) {
    if (!(await processNextGeographyJob(input.workerId))) break;
    processed += 1;
  }
  return { queued, processed };
}

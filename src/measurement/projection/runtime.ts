import type { PoolClient } from "pg";
import { pool, withTransaction } from "../../db/pool.js";
import { safeFailureMessage } from "../../runtime/failure.js";
import { retryDelaySeconds } from "../../runtime/retry.js";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";
import { measurementConfig } from "../config.js";
import { processEntityObservations } from "../entities/runtime.js";
import { getMeasurementRegistration } from "../registry.js";
import { measurementSourceProjectors } from "../sources/registry.js";
import { bucketForDate, bucketForInstant } from "../time.js";
import type {
  CandidateFact,
  CanonicalProjectionInput,
  RawProjectionInput,
} from "./types.js";

const RAW_MEASUREMENT_KEYS = [
  "vulnerability.cisa_kev.membership_removals_observed",
  "vulnerability.cisa_kev.catalog_size",
  "exploitation.epss.scored_records",
] as const;

export interface ClaimedProjectionJob {
  id: string;
  measurementCalculationId: string;
  measurementKey: string;
  targetKind: "RAW_RECORD" | "CANONICAL_RECORD";
  rawRecordId: string | null;
  canonicalRecordId: string | null;
  sourceDefinitionId: string;
  sourceKey: string;
  projectorKey: string;
  attemptCount: number;
}

interface CanonicalInputRow {
  id: string;
  raw_record_id: string;
  source_definition_id: string;
  source_key: string;
  source_record_id: string;
  record_kind: string;
  canonical_key: string;
  received_at: Date;
  published_at: Date | null;
  effective_at: Date | null;
  upstream_updated_at: Date | null;
  entities: unknown;
  facts: unknown;
  normalized_sha256: string;
  trigger: string;
  purpose: string;
  source_revision_number: number;
}

interface RawInputRow {
  id: string;
  source_definition_id: string;
  source_key: string;
  source_record_id: string;
  payload: unknown;
  payload_sha256: string;
  received_at: Date;
  published_at: Date | null;
  effective_at: Date | null;
  upstream_updated_at: Date | null;
  trigger: string;
  purpose: string;
  source_revision_number: number;
  previous_id: string | null;
  previous_payload: unknown;
  previous_payload_sha256: string | null;
  previous_received_at: Date | null;
}

interface FactHeadRow {
  current_fact_id: string;
  revision_number: number;
  input_fingerprint: string;
  event_time: Date | null;
  event_date: string | null;
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export async function discoverProjectionJobs(limit = 500): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000) {
    throw new Error("Invalid projection discovery limit");
  }

  return withTransaction(async (client) => {
    const canonical = await client.query(
      `INSERT INTO measurement_projection_jobs(
         measurement_calculation_id,target_kind,canonical_record_id,
         source_definition_id,projector_key,state
       )
       SELECT heads.active_calculation_id,'CANONICAL_RECORD',canonical.id,
              canonical.source_definition_id,calculation.projector_key,'QUEUED'
       FROM canonical_evidence_records canonical
       JOIN source_definitions source ON source.id=canonical.source_definition_id
       CROSS JOIN measurement_definition_heads heads
       JOIN measurement_definitions definition ON definition.id=heads.active_definition_id
       JOIN measurement_calculation_versions calculation ON calculation.id=heads.active_calculation_id
       WHERE source.enabled = true
         AND definition.source_scope ? source.source_key
         AND definition.record_kind_scope ? canonical.record_kind
         AND NOT EXISTS (
           SELECT 1 FROM measurement_projection_jobs existing
           WHERE existing.measurement_calculation_id=heads.active_calculation_id
             AND existing.canonical_record_id=canonical.id
         )
       ORDER BY canonical.created_at,definition.measurement_key
       LIMIT $1
       ON CONFLICT DO NOTHING`,
      [limit],
    );

    const remaining = Math.max(0, limit - (canonical.rowCount ?? 0));
    if (remaining === 0) return canonical.rowCount ?? 0;

    const raw = await client.query(
      `INSERT INTO measurement_projection_jobs(
         measurement_calculation_id,target_kind,raw_record_id,
         source_definition_id,projector_key,state
       )
       SELECT heads.active_calculation_id,'RAW_RECORD',raw.id,
              raw.source_definition_id,calculation.projector_key,'QUEUED'
       FROM raw_source_records raw
       JOIN source_definitions source ON source.id=raw.source_definition_id
       CROSS JOIN measurement_definition_heads heads
       JOIN measurement_definitions definition ON definition.id=heads.active_definition_id
       JOIN measurement_calculation_versions calculation ON calculation.id=heads.active_calculation_id
       WHERE source.enabled = true
         AND definition.source_scope ? source.source_key
         AND definition.measurement_key=ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1 FROM measurement_projection_jobs existing
           WHERE existing.measurement_calculation_id=heads.active_calculation_id
             AND existing.raw_record_id=raw.id
         )
       ORDER BY raw.created_at,definition.measurement_key
       LIMIT $2
       ON CONFLICT DO NOTHING`,
      [[...RAW_MEASUREMENT_KEYS], remaining],
    );

    return (canonical.rowCount ?? 0) + (raw.rowCount ?? 0);
  });
}

const projectionSourceKeys = [...measurementSourceProjectors.keys()];
let projectionSourceCursor = 0;

async function claimProjectionJobForSource(
  workerId: string,
  sourceKey: string,
): Promise<ClaimedProjectionJob | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      measurement_calculation_id: string;
      measurement_key: string;
      target_kind: "RAW_RECORD" | "CANONICAL_RECORD";
      raw_record_id: string | null;
      canonical_record_id: string | null;
      source_definition_id: string;
      source_key: string;
      projector_key: string;
      attempt_count: number;
    }>(
      `SELECT job.id,job.measurement_calculation_id,definition.measurement_key,
              job.target_kind,job.raw_record_id,job.canonical_record_id,
              job.source_definition_id,source.source_key,job.projector_key,job.attempt_count
       FROM measurement_projection_jobs job
       JOIN measurement_calculation_versions calculation ON calculation.id=job.measurement_calculation_id
       JOIN measurement_definitions definition ON definition.id=calculation.measurement_definition_id
       JOIN source_definitions source ON source.id=job.source_definition_id
       WHERE source.source_key=$1
         AND source.enabled = true
         AND (
           (job.state='QUEUED' AND job.available_at<=now())
           OR (job.state='RUNNING' AND job.lease_expires_at<now())
         )
       ORDER BY job.created_at
       FOR UPDATE OF job SKIP LOCKED
       LIMIT 1`,
      [sourceKey],
    );

    const row = selected.rows[0];
    if (!row) return null;

    const claimed = await client.query<{ attempt_count: number }>(
      `UPDATE measurement_projection_jobs
       SET state='RUNNING',attempt_count=attempt_count+1,
           started_at=COALESCE(started_at,now()),lease_owner=$2,
           lease_expires_at=now()+($3::text||' seconds')::interval,updated_at=now()
       WHERE id=$1
       RETURNING attempt_count`,
      [row.id, workerId, measurementConfig.leaseSeconds],
    );

    return {
      id: row.id,
      measurementCalculationId: row.measurement_calculation_id,
      measurementKey: row.measurement_key,
      targetKind: row.target_kind,
      rawRecordId: row.raw_record_id,
      canonicalRecordId: row.canonical_record_id,
      sourceDefinitionId: row.source_definition_id,
      sourceKey: row.source_key,
      projectorKey: row.projector_key,
      attemptCount: claimed.rows[0]?.attempt_count ?? row.attempt_count + 1,
    };
  });
}

async function claimProjectionJob(workerId: string): Promise<ClaimedProjectionJob | null> {
  if (projectionSourceKeys.length === 0) return null;

  for (let offset = 0; offset < projectionSourceKeys.length; offset += 1) {
    const index = (projectionSourceCursor + offset) % projectionSourceKeys.length;
    const sourceKey = projectionSourceKeys[index];
    if (!sourceKey) continue;

    const job = await claimProjectionJobForSource(workerId, sourceKey);
    if (!job) continue;

    projectionSourceCursor = (index + 1) % projectionSourceKeys.length;
    return job;
  }

  return null;
}

async function loadCanonicalInput(job: ClaimedProjectionJob): Promise<CanonicalProjectionInput> {
  if (!job.canonicalRecordId) {
    throw new Error("Canonical projection job lacks canonical_record_id");
  }

  const result = await pool.query<CanonicalInputRow>(
    `SELECT canonical.id,canonical.raw_record_id,canonical.source_definition_id,
            source.source_key,canonical.source_record_id,canonical.record_kind,
            canonical.canonical_key,canonical.received_at,canonical.published_at,
            canonical.effective_at,canonical.upstream_updated_at,canonical.entities,
            canonical.facts,canonical.normalized_sha256,run.trigger,run.purpose,
            (
              SELECT count(*)::int
              FROM raw_source_records prior
              WHERE prior.source_definition_id=raw.source_definition_id
                AND prior.source_record_id=raw.source_record_id
                AND (
                  prior.created_at<raw.created_at
                  OR (prior.created_at=raw.created_at AND prior.id::text<=raw.id::text)
                )
            ) AS source_revision_number
     FROM canonical_evidence_records canonical
     JOIN raw_source_records raw ON raw.id=canonical.raw_record_id
     JOIN collection_runs run ON run.id=raw.collection_run_id
     JOIN source_definitions source ON source.id=canonical.source_definition_id
     WHERE canonical.id=$1`,
    [job.canonicalRecordId],
  );

  const row = result.rows[0];
  if (!row) throw new Error("Canonical projection input no longer exists");

  return {
    id: row.id,
    rawRecordId: row.raw_record_id,
    sourceDefinitionId: row.source_definition_id,
    sourceKey: row.source_key,
    sourceRecordId: row.source_record_id,
    recordKind: row.record_kind,
    canonicalKey: row.canonical_key,
    receivedAt: row.received_at.toISOString(),
    publishedAt: iso(row.published_at),
    effectiveAt: iso(row.effective_at),
    upstreamUpdatedAt: iso(row.upstream_updated_at),
    entities: row.entities,
    facts: row.facts,
    normalizedSha256: row.normalized_sha256,
    sourceRevisionNumber: row.source_revision_number,
    trigger: row.trigger,
    purpose: row.purpose,
  };
}

async function loadRawInput(job: ClaimedProjectionJob): Promise<RawProjectionInput> {
  if (!job.rawRecordId) throw new Error("Raw projection job lacks raw_record_id");

  const result = await pool.query<RawInputRow>(
    `SELECT raw.id,raw.source_definition_id,source.source_key,raw.source_record_id,
            raw.payload,raw.payload_sha256,raw.received_at,raw.published_at,
            raw.effective_at,raw.upstream_updated_at,run.trigger,run.purpose,
            (
              SELECT count(*)::int
              FROM raw_source_records prior
              WHERE prior.source_definition_id=raw.source_definition_id
                AND prior.source_record_id=raw.source_record_id
                AND (
                  prior.created_at<raw.created_at
                  OR (prior.created_at=raw.created_at AND prior.id::text<=raw.id::text)
                )
            ) AS source_revision_number,
            previous.id AS previous_id,previous.payload AS previous_payload,
            previous.payload_sha256 AS previous_payload_sha256,
            previous.received_at AS previous_received_at
     FROM raw_source_records raw
     JOIN collection_runs run ON run.id=raw.collection_run_id
     JOIN source_definitions source ON source.id=raw.source_definition_id
     LEFT JOIN LATERAL (
       SELECT p.id,p.payload,p.payload_sha256,p.received_at
       FROM raw_source_records p
       WHERE p.source_definition_id=raw.source_definition_id
         AND p.source_record_id=raw.source_record_id
         AND (
           p.created_at<raw.created_at
           OR (p.created_at=raw.created_at AND p.id::text<raw.id::text)
         )
       ORDER BY p.created_at DESC,p.id::text DESC
       LIMIT 1
     ) previous ON true
     WHERE raw.id=$1`,
    [job.rawRecordId],
  );

  const row = result.rows[0];
  if (!row) throw new Error("Raw projection input no longer exists");

  return {
    id: row.id,
    sourceDefinitionId: row.source_definition_id,
    sourceKey: row.source_key,
    sourceRecordId: row.source_record_id,
    payload: row.payload,
    payloadSha256: row.payload_sha256,
    receivedAt: row.received_at.toISOString(),
    publishedAt: iso(row.published_at),
    effectiveAt: iso(row.effective_at),
    upstreamUpdatedAt: iso(row.upstream_updated_at),
    sourceRevisionNumber: row.source_revision_number,
    trigger: row.trigger,
    purpose: row.purpose,
    previousRawRecord:
      row.previous_id && row.previous_payload_sha256 && row.previous_received_at
        ? {
            id: row.previous_id,
            payload: row.previous_payload,
            payloadSha256: row.previous_payload_sha256,
            receivedAt: row.previous_received_at.toISOString(),
          }
        : null,
  };
}

async function markDirty(
  client: PoolClient,
  calculationId: string,
  candidate: Pick<CandidateFact, "measurementKey" | "eventTime" | "eventDate">,
  reason: string,
): Promise<void> {
  const registration = getMeasurementRegistration(candidate.measurementKey);
  if (!registration) throw new Error(`Unknown measurement ${candidate.measurementKey}`);

  for (const granularity of registration.definition.supportedGranularities) {
    if (candidate.eventDate && granularity !== "DAY") continue;
    if (!candidate.eventDate && !candidate.eventTime) {
      throw new Error("Measurement fact candidate has no event time or date");
    }

    const bucket = candidate.eventDate
      ? bucketForDate(candidate.eventDate)
      : bucketForInstant(candidate.eventTime as string, granularity);

    await client.query(
      `INSERT INTO measurement_dirty_buckets(
         measurement_calculation_id,granularity,bucket_start,bucket_end,
         scope_key,dirty_revision,dirty_reasons
       )
       VALUES ($1,$2,$3,$4,'GLOBAL',1,jsonb_build_array($5::text))
       ON CONFLICT (measurement_calculation_id,granularity,bucket_start,scope_key)
       DO UPDATE SET
         bucket_end=EXCLUDED.bucket_end,
         dirty_revision=measurement_dirty_buckets.dirty_revision+1,
         dirty_reasons=measurement_dirty_buckets.dirty_reasons||EXCLUDED.dirty_reasons,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=now()`,
      [calculationId, granularity, bucket.start, bucket.end, reason],
    );
  }
}

export async function applyMeasurementFactCandidate(input: {
  client: PoolClient;
  calculationId: string;
  sourceDefinitionId: string;
  candidate: CandidateFact;
  canonicalRecordId?: string | null;
  rawRecordId?: string | null;
  previousRawRecordId?: string | null;
  reason?: string;
}): Promise<boolean> {
  const current = await input.client.query<FactHeadRow>(
    `SELECT head.current_fact_id,fact.revision_number,fact.input_fingerprint,
            fact.event_time,fact.event_date::text
     FROM measurement_fact_heads head
     JOIN measurement_facts fact ON fact.id=head.current_fact_id
     WHERE head.measurement_calculation_id=$1 AND head.fact_key=$2
     FOR UPDATE OF head`,
    [input.calculationId, input.candidate.factKey],
  );

  const prior = current.rows[0];
  if (prior?.input_fingerprint === input.candidate.inputFingerprint) return false;

  if (prior) {
    await markDirty(
      input.client,
      input.calculationId,
      {
        measurementKey: input.candidate.measurementKey,
        eventTime: iso(prior.event_time),
        eventDate: prior.event_date,
      },
      "FACT_REVISED",
    );
  }

  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO measurement_facts(
       measurement_calculation_id,fact_key,revision_number,fact_state,
       source_definition_id,fact_kind,event_time,event_date,time_precision,
       numeric_value,entity_key,entity_type,dimensions,acquisition_basis,
       source_model_version,input_fingerprint,supersedes_fact_id
     )
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16)
     RETURNING id`,
    [
      input.calculationId,
      input.candidate.factKey,
      (prior?.revision_number ?? 0) + 1,
      input.sourceDefinitionId,
      input.candidate.factKind,
      input.candidate.eventTime,
      input.candidate.eventDate,
      input.candidate.timePrecision,
      input.candidate.numericValue,
      input.candidate.entityKey,
      input.candidate.entityType,
      canonicalJsonStringify(input.candidate.dimensions),
      input.candidate.acquisitionBasis,
      input.candidate.sourceModelVersion,
      input.candidate.inputFingerprint,
      prior?.current_fact_id ?? null,
    ],
  );

  const factId = inserted.rows[0]?.id;
  if (!factId) throw new Error("Failed to append measurement fact revision");

  await input.client.query(
    `INSERT INTO measurement_fact_heads(
       measurement_calculation_id,fact_key,current_fact_id,fact_state,
       source_definition_id,event_time,event_date,entity_key,entity_type,updated_at
     )
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7,$8,now())
     ON CONFLICT (measurement_calculation_id,fact_key)
     DO UPDATE SET
       current_fact_id=EXCLUDED.current_fact_id,
       fact_state='ACTIVE',
       source_definition_id=EXCLUDED.source_definition_id,
       event_time=EXCLUDED.event_time,
       event_date=EXCLUDED.event_date,
       entity_key=EXCLUDED.entity_key,
       entity_type=EXCLUDED.entity_type,
       updated_at=now()`,
    [
      input.calculationId,
      input.candidate.factKey,
      factId,
      input.sourceDefinitionId,
      input.candidate.eventTime,
      input.candidate.eventDate,
      input.candidate.entityKey,
      input.candidate.entityType,
    ],
  );

  if (input.canonicalRecordId) {
    await input.client.query(
      `INSERT INTO measurement_fact_inputs(
         measurement_fact_id,input_role,canonical_record_id
       ) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [factId, input.candidate.inputRole, input.canonicalRecordId],
    );
  }

  if (input.rawRecordId) {
    await input.client.query(
      `INSERT INTO measurement_fact_inputs(
         measurement_fact_id,input_role,raw_record_id
       ) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [factId, `${input.candidate.inputRole}_CURRENT`, input.rawRecordId],
    );
  }

  if (input.previousRawRecordId) {
    await input.client.query(
      `INSERT INTO measurement_fact_inputs(
         measurement_fact_id,input_role,raw_record_id
       ) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [factId, `${input.candidate.inputRole}_PREVIOUS`, input.previousRawRecordId],
    );
  }

  await markDirty(
    input.client,
    input.calculationId,
    input.candidate,
    input.reason ?? (prior ? "FACT_REVISED" : "NEW_FACT"),
  );
  return true;
}

async function assertLease(
  client: PoolClient,
  jobId: string,
  workerId: string,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM measurement_projection_jobs
     WHERE id=$1 AND state='RUNNING' AND lease_owner=$2
     FOR UPDATE`,
    [jobId, workerId],
  );
  if (!result.rowCount) {
    throw new Error("Measurement projection lease was lost before persistence");
  }
}

async function persistSuccess(input: {
  job: ClaimedProjectionJob;
  workerId: string;
  candidates: readonly CandidateFact[];
  canonical?: CanonicalProjectionInput;
  raw?: RawProjectionInput;
}): Promise<void> {
  await withTransaction(async (client) => {
    await assertLease(client, input.job.id, input.workerId);
    let written = 0;

    for (const candidate of input.candidates) {
      if (candidate.measurementKey !== input.job.measurementKey) {
        throw new Error("Projector emitted a fact for the wrong measurement job");
      }
      const changed = await applyMeasurementFactCandidate({
        client,
        calculationId: input.job.measurementCalculationId,
        sourceDefinitionId: input.job.sourceDefinitionId,
        candidate,
        canonicalRecordId: input.canonical?.id ?? null,
        rawRecordId: input.raw?.id ?? null,
        previousRawRecordId: input.raw?.previousRawRecord?.id ?? null,
      });
      if (changed) written += 1;
    }

    if (input.canonical) {
      await processEntityObservations({ client, canonical: input.canonical });
    }

    await client.query(
      `UPDATE measurement_projection_jobs
       SET state='SUCCEEDED',output_fact_count=$2,finished_at=now(),
           lease_owner=NULL,lease_expires_at=NULL,
           failure_code=NULL,failure_message=NULL,updated_at=now()
       WHERE id=$1`,
      [input.job.id, written],
    );
  });
}

async function persistFailure(
  job: ClaimedProjectionJob,
  workerId: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);

  await withTransaction(async (client) => {
    const lease = await client.query(
      `SELECT 1
       FROM measurement_projection_jobs
       WHERE id=$1 AND state='RUNNING' AND lease_owner=$2
       FOR UPDATE`,
      [job.id, workerId],
    );
    if (!lease.rowCount) return;

    const retry = job.attemptCount < measurementConfig.maxAttempts;
    const delay = retry
      ? retryDelaySeconds({
          attemptCount: job.attemptCount,
          baseSeconds: 5,
          maxSeconds: 300,
        })
      : 0;

    await client.query(
      `UPDATE measurement_projection_jobs
       SET state=$2,
           available_at=CASE
             WHEN $2='QUEUED' THEN now()+($4::int*interval '1 second')
             ELSE available_at
           END,
           lease_owner=NULL,
           lease_expires_at=NULL,
           finished_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,
           failure_code='PROJECTION_ERROR',
           failure_message=$3,
           updated_at=now()
       WHERE id=$1`,
      [job.id, retry ? "QUEUED" : "FAILED", safeFailureMessage(message), delay],
    );
  });
}

export async function projectionTick(workerId: string): Promise<boolean> {
  const job = await claimProjectionJob(workerId);
  if (!job) return false;

  const projector = measurementSourceProjectors.get(job.sourceKey);
  if (!projector) {
    await persistFailure(job, workerId, new Error(`No NODE-3 projector for ${job.sourceKey}`));
    return true;
  }

  try {
    if (job.targetKind === "CANONICAL_RECORD") {
      const canonical = await loadCanonicalInput(job);
      await persistSuccess({
        job,
        workerId,
        candidates: projector.projectCanonical(canonical, job.measurementKey),
        canonical,
      });
    } else {
      const raw = await loadRawInput(job);
      await persistSuccess({
        job,
        workerId,
        candidates: projector.projectRaw(raw, job.measurementKey),
        raw,
      });
    }
  } catch (error) {
    await persistFailure(job, workerId, error);
  }

  return true;
}

export async function projectionQueueDepth(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM measurement_projection_jobs
     WHERE state IN ('QUEUED','RUNNING')`,
  );
  return result.rows[0]?.count ?? 0;
}

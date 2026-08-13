import type { PoolClient } from "pg";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";
import { getMeasurementRegistration } from "../registry.js";
import { bucketForDate, bucketForInstant } from "../time.js";
import { sha256 } from "./utils.js";

async function markOldBucketDirty(input: {
  client: PoolClient;
  calculationId: string;
  measurementKey: string;
  eventTime: Date | null;
  eventDate: string | null;
}): Promise<void> {
  const registration = getMeasurementRegistration(input.measurementKey);
  if (!registration) throw new Error(`Unknown measurement ${input.measurementKey}`);

  for (const granularity of registration.definition.supportedGranularities) {
    if (input.eventDate && granularity !== "DAY") continue;
    if (!input.eventDate && !input.eventTime) continue;
    const bucket = input.eventDate
      ? bucketForDate(input.eventDate)
      : bucketForInstant(input.eventTime as Date, granularity);

    await input.client.query(
      `INSERT INTO measurement_dirty_buckets(
         measurement_calculation_id,granularity,bucket_start,bucket_end,
         scope_key,dirty_revision,dirty_reasons
       ) VALUES ($1,$2,$3,$4,'GLOBAL',1,'["FACT_RETRACTED"]'::jsonb)
       ON CONFLICT (measurement_calculation_id,granularity,bucket_start,scope_key)
       DO UPDATE SET
         bucket_end=EXCLUDED.bucket_end,
         dirty_revision=measurement_dirty_buckets.dirty_revision+1,
         dirty_reasons=measurement_dirty_buckets.dirty_reasons||EXCLUDED.dirty_reasons,
         lease_owner=NULL,lease_expires_at=NULL,updated_at=now()`,
      [input.calculationId, granularity, bucket.start, bucket.end],
    );
  }
}

export async function retractMeasurementFactByIdentity(input: {
  client: PoolClient;
  measurementKey: string;
  identity: unknown;
  sourceDefinitionId: string;
  canonicalRecordId: string;
  reason: string;
}): Promise<boolean> {
  const definition = await input.client.query<{ active_calculation_id: string }>(
    `SELECT active_calculation_id
     FROM measurement_definition_heads
     WHERE measurement_key=$1`,
    [input.measurementKey],
  );
  const calculationId = definition.rows[0]?.active_calculation_id;
  if (!calculationId) return false;

  const factKey = sha256({ measurementKey: input.measurementKey, identity: input.identity });
  const current = await input.client.query<{
    current_fact_id: string;
    fact_state: string;
    revision_number: number;
    fact_kind: string;
    event_time: Date | null;
    event_date: string | null;
    time_precision: string;
    numeric_value: string | null;
    entity_key: string | null;
    entity_type: string | null;
    dimensions: Record<string, unknown>;
    acquisition_basis: string;
    source_model_version: string | null;
    input_fingerprint: string;
  }>(
    `SELECT head.current_fact_id,head.fact_state,fact.revision_number,
            fact.fact_kind,fact.event_time,fact.event_date::text,fact.time_precision,
            fact.numeric_value::text,fact.entity_key,fact.entity_type,fact.dimensions,
            fact.acquisition_basis,fact.source_model_version,fact.input_fingerprint
     FROM measurement_fact_heads head
     JOIN measurement_facts fact ON fact.id=head.current_fact_id
     WHERE head.measurement_calculation_id=$1 AND head.fact_key=$2
     FOR UPDATE OF head`,
    [calculationId, factKey],
  );

  const prior = current.rows[0];
  if (!prior || prior.fact_state === "RETRACTED") return false;

  const retractionFingerprint = sha256({
    prior: prior.input_fingerprint,
    canonicalRecordId: input.canonicalRecordId,
    reason: input.reason,
  });
  const inserted = await input.client.query<{ id: string }>(
    `INSERT INTO measurement_facts(
       measurement_calculation_id,fact_key,revision_number,fact_state,
       source_definition_id,fact_kind,event_time,event_date,time_precision,
       numeric_value,entity_key,entity_type,dimensions,acquisition_basis,
       source_model_version,input_fingerprint,supersedes_fact_id
     ) VALUES (
       $1,$2,$3,'RETRACTED',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16
     ) RETURNING id`,
    [
      calculationId,
      factKey,
      prior.revision_number + 1,
      input.sourceDefinitionId,
      prior.fact_kind,
      prior.event_time,
      prior.event_date,
      prior.time_precision,
      prior.numeric_value,
      prior.entity_key,
      prior.entity_type,
      canonicalJsonStringify(prior.dimensions),
      prior.acquisition_basis,
      prior.source_model_version,
      retractionFingerprint,
      prior.current_fact_id,
    ],
  );
  const factId = inserted.rows[0]?.id;
  if (!factId) throw new Error("Failed to append measurement fact retraction");

  await input.client.query(
    `UPDATE measurement_fact_heads
     SET current_fact_id=$3,fact_state='RETRACTED',updated_at=now()
     WHERE measurement_calculation_id=$1 AND fact_key=$2`,
    [calculationId, factKey, factId],
  );
  await input.client.query(
    `INSERT INTO measurement_fact_inputs(
       measurement_fact_id,input_role,canonical_record_id
     ) VALUES ($1,'RETRACTION_CAUSE',$2)
     ON CONFLICT DO NOTHING`,
    [factId, input.canonicalRecordId],
  );
  await markOldBucketDirty({
    client: input.client,
    calculationId,
    measurementKey: input.measurementKey,
    eventTime: prior.event_time,
    eventDate: prior.event_date,
  });
  return true;
}

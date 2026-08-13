BEGIN;

CREATE TABLE measurement_projection_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK (target_kind IN ('RAW_RECORD','CANONICAL_RECORD')),
  raw_record_id uuid REFERENCES raw_source_records(id) ON DELETE CASCADE,
  canonical_record_id uuid REFERENCES canonical_evidence_records(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  projector_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  output_fact_count integer NOT NULL DEFAULT 0 CHECK (output_fact_count >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(raw_record_id, canonical_record_id) = 1),
  CHECK ((target_kind = 'RAW_RECORD' AND raw_record_id IS NOT NULL) OR (target_kind = 'CANONICAL_RECORD' AND canonical_record_id IS NOT NULL))
);
CREATE UNIQUE INDEX measurement_projection_jobs_raw_unique ON measurement_projection_jobs(measurement_calculation_id, raw_record_id) WHERE raw_record_id IS NOT NULL;
CREATE UNIQUE INDEX measurement_projection_jobs_canonical_unique ON measurement_projection_jobs(measurement_calculation_id, canonical_record_id) WHERE canonical_record_id IS NOT NULL;
CREATE INDEX measurement_projection_jobs_claim_idx ON measurement_projection_jobs(state, available_at, lease_expires_at, created_at);

CREATE TABLE measurement_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE RESTRICT,
  fact_key char(64) NOT NULL CHECK (fact_key ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  fact_state text NOT NULL CHECK (fact_state IN ('ACTIVE','RETRACTED')),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  fact_kind text NOT NULL CHECK (fact_kind IN ('EVENT','OBSERVATION','SNAPSHOT_VALUE','STATE_VALUE')),
  event_time timestamptz,
  event_date date,
  time_precision text NOT NULL CHECK (time_precision IN ('INSTANT','DATE')),
  numeric_value numeric,
  entity_key text,
  entity_type text,
  dimensions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(dimensions) = 'object'),
  acquisition_basis text NOT NULL CHECK (acquisition_basis IN ('LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','RECOVERY','HISTORICAL_BACKFILL','RESYNC','REPAIR','SNAPSHOT_RECONSTRUCTION')),
  source_model_version text,
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_fact_id uuid REFERENCES measurement_facts(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(event_time, event_date) = 1),
  CHECK ((time_precision = 'INSTANT' AND event_time IS NOT NULL) OR (time_precision = 'DATE' AND event_date IS NOT NULL)),
  UNIQUE (measurement_calculation_id, fact_key, revision_number)
);
CREATE INDEX measurement_facts_calc_time_idx ON measurement_facts(measurement_calculation_id, event_time) WHERE event_time IS NOT NULL;
CREATE INDEX measurement_facts_calc_date_idx ON measurement_facts(measurement_calculation_id, event_date) WHERE event_date IS NOT NULL;
CREATE INDEX measurement_facts_entity_idx ON measurement_facts(entity_key, event_time) WHERE entity_key IS NOT NULL;

CREATE TABLE measurement_fact_heads (
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE CASCADE,
  fact_key char(64) NOT NULL CHECK (fact_key ~ '^[0-9a-f]{64}$'),
  current_fact_id uuid NOT NULL REFERENCES measurement_facts(id) ON DELETE RESTRICT,
  fact_state text NOT NULL CHECK (fact_state IN ('ACTIVE','RETRACTED')),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  event_time timestamptz,
  event_date date,
  entity_key text,
  entity_type text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(event_time, event_date) = 1),
  PRIMARY KEY (measurement_calculation_id, fact_key)
);
CREATE INDEX measurement_fact_heads_calc_time_idx ON measurement_fact_heads(measurement_calculation_id, event_time) WHERE event_time IS NOT NULL AND fact_state = 'ACTIVE';
CREATE INDEX measurement_fact_heads_calc_date_idx ON measurement_fact_heads(measurement_calculation_id, event_date) WHERE event_date IS NOT NULL AND fact_state = 'ACTIVE';
CREATE INDEX measurement_fact_heads_entity_idx ON measurement_fact_heads(entity_key, event_time) WHERE entity_key IS NOT NULL AND fact_state = 'ACTIVE';

CREATE TABLE measurement_fact_inputs (
  measurement_fact_id uuid NOT NULL REFERENCES measurement_facts(id) ON DELETE CASCADE,
  input_role text NOT NULL,
  raw_record_id uuid REFERENCES raw_source_records(id) ON DELETE RESTRICT,
  canonical_record_id uuid REFERENCES canonical_evidence_records(id) ON DELETE RESTRICT,
  collection_run_id uuid REFERENCES collection_runs(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(raw_record_id, canonical_record_id, collection_run_id) = 1)
);
CREATE UNIQUE INDEX measurement_fact_inputs_raw_unique ON measurement_fact_inputs(measurement_fact_id,input_role,raw_record_id) WHERE raw_record_id IS NOT NULL;
CREATE UNIQUE INDEX measurement_fact_inputs_canonical_unique ON measurement_fact_inputs(measurement_fact_id,input_role,canonical_record_id) WHERE canonical_record_id IS NOT NULL;
CREATE UNIQUE INDEX measurement_fact_inputs_run_unique ON measurement_fact_inputs(measurement_fact_id,input_role,collection_run_id) WHERE collection_run_id IS NOT NULL;
CREATE INDEX measurement_fact_inputs_raw_idx ON measurement_fact_inputs(raw_record_id) WHERE raw_record_id IS NOT NULL;
CREATE INDEX measurement_fact_inputs_canonical_idx ON measurement_fact_inputs(canonical_record_id) WHERE canonical_record_id IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_node3_fact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NODE-3 measurement facts are immutable; append a new fact revision instead'; END; $$;
CREATE TRIGGER measurement_facts_immutable_update BEFORE UPDATE ON measurement_facts FOR EACH ROW EXECUTE FUNCTION reject_node3_fact_update();

COMMIT;

BEGIN;

CREATE TABLE entity_observation_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_key char(64) NOT NULL CHECK (observation_key ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  entity_key text NOT NULL,
  entity_type text NOT NULL,
  entity_role text NOT NULL,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  source_record_id text NOT NULL,
  canonical_record_id uuid NOT NULL REFERENCES canonical_evidence_records(id) ON DELETE RESTRICT,
  raw_record_id uuid NOT NULL REFERENCES raw_source_records(id) ON DELETE RESTRICT,
  observed_time timestamptz,
  observed_date date,
  time_precision text NOT NULL CHECK (time_precision IN ('INSTANT','DATE')),
  observation_basis text NOT NULL CHECK (observation_basis IN ('OBSERVED','REPORTED','PUBLISHED','SCORED','ENRICHED','UNKNOWN')),
  acquisition_basis text NOT NULL CHECK (acquisition_basis IN ('LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','RECOVERY','HISTORICAL_BACKFILL','RESYNC','REPAIR','SNAPSHOT_RECONSTRUCTION')),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_id uuid REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(observed_time, observed_date) = 1),
  CHECK ((time_precision = 'INSTANT' AND observed_time IS NOT NULL) OR (time_precision = 'DATE' AND observed_date IS NOT NULL)),
  UNIQUE (observation_key, revision_number)
);
CREATE INDEX entity_observation_revisions_entity_idx ON entity_observation_revisions(entity_type, entity_key, revision_number DESC);

CREATE TABLE entity_observation_heads (
  observation_key char(64) PRIMARY KEY CHECK (observation_key ~ '^[0-9a-f]{64}$'),
  current_revision_id uuid NOT NULL REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  entity_key text NOT NULL,
  entity_type text NOT NULL,
  entity_role text NOT NULL,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  observed_time timestamptz,
  observed_date date,
  acquisition_basis text NOT NULL CHECK (acquisition_basis IN ('LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','RECOVERY','HISTORICAL_BACKFILL','RESYNC','REPAIR','SNAPSHOT_RECONSTRUCTION')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(observed_time, observed_date) = 1)
);
CREATE INDEX entity_observation_heads_entity_idx ON entity_observation_heads(entity_type, entity_key) WHERE state = 'ACTIVE';
CREATE INDEX entity_observation_heads_time_idx ON entity_observation_heads(observed_time) WHERE observed_time IS NOT NULL AND state = 'ACTIVE';

CREATE TABLE entity_history_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_key text NOT NULL,
  entity_type text NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  first_seen_time timestamptz,
  first_seen_date date,
  last_seen_time timestamptz,
  last_seen_date date,
  first_source_definition_id uuid REFERENCES source_definitions(id) ON DELETE RESTRICT,
  last_source_definition_id uuid REFERENCES source_definitions(id) ON DELETE RESTRICT,
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  source_count integer NOT NULL CHECK (source_count >= 0),
  revision_acquisition_basis text NOT NULL CHECK (revision_acquisition_basis IN ('LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','RECOVERY','HISTORICAL_BACKFILL','RESYNC','REPAIR','SNAPSHOT_RECONSTRUCTION')),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_id uuid REFERENCES entity_history_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(first_seen_time, first_seen_date) = 1),
  CHECK (num_nonnulls(last_seen_time, last_seen_date) = 1),
  UNIQUE (entity_type, entity_key, revision_number)
);
CREATE INDEX entity_history_revisions_lookup_idx ON entity_history_revisions(entity_type, entity_key, revision_number DESC);

CREATE TABLE entity_history_heads (
  entity_key text NOT NULL,
  entity_type text NOT NULL,
  current_revision_id uuid NOT NULL REFERENCES entity_history_revisions(id) ON DELETE RESTRICT,
  first_seen_time timestamptz,
  first_seen_date date,
  last_seen_time timestamptz,
  last_seen_date date,
  first_source_definition_id uuid REFERENCES source_definitions(id) ON DELETE RESTRICT,
  last_source_definition_id uuid REFERENCES source_definitions(id) ON DELETE RESTRICT,
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  source_count integer NOT NULL CHECK (source_count >= 0),
  revision_acquisition_basis text NOT NULL CHECK (revision_acquisition_basis IN ('LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','RECOVERY','HISTORICAL_BACKFILL','RESYNC','REPAIR','SNAPSHOT_RECONSTRUCTION')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(first_seen_time, first_seen_date) = 1),
  CHECK (num_nonnulls(last_seen_time, last_seen_date) = 1),
  PRIMARY KEY (entity_type, entity_key)
);
CREATE INDEX entity_history_heads_first_time_idx ON entity_history_heads(first_seen_time) WHERE first_seen_time IS NOT NULL;
CREATE INDEX entity_history_heads_first_date_idx ON entity_history_heads(first_seen_date) WHERE first_seen_date IS NOT NULL;

CREATE TABLE entity_history_measurement_receipts (
  entity_history_revision_id uuid NOT NULL REFERENCES entity_history_revisions(id) ON DELETE CASCADE,
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE CASCADE,
  projected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_history_revision_id, measurement_calculation_id)
);

CREATE OR REPLACE FUNCTION reject_node3_entity_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NODE-3 entity observation/history revisions are immutable; append a new revision instead'; END; $$;
CREATE TRIGGER entity_observation_revisions_immutable_update BEFORE UPDATE ON entity_observation_revisions FOR EACH ROW EXECUTE FUNCTION reject_node3_entity_revision_update();
CREATE TRIGGER entity_history_revisions_immutable_update BEFORE UPDATE ON entity_history_revisions FOR EACH ROW EXECUTE FUNCTION reject_node3_entity_revision_update();

COMMIT;

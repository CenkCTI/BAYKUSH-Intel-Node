BEGIN;

CREATE TABLE entity_source_presence_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL REFERENCES technical_entity_registry(id) ON DELETE RESTRICT,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  first_seen_time timestamptz,
  first_seen_date date,
  last_seen_time timestamptz,
  last_seen_date date,
  first_node_received_at timestamptz,
  last_node_received_at timestamptz,
  observation_count bigint NOT NULL CHECK (observation_count >= 0),
  primary_observation_count bigint NOT NULL CHECK (primary_observation_count >= 0),
  related_observation_count bigint NOT NULL CHECK (related_observation_count >= 0),
  source_class_snapshot text NOT NULL,
  observation_basis_snapshot text NOT NULL CHECK (observation_basis_snapshot IN ('OBSERVED','REPORTED','PUBLISHED','SCORED','ENRICHED','UNKNOWN')),
  upstream_origin_key_snapshot text NOT NULL,
  semantic_contract_version_snapshot text NOT NULL,
  acquisition_bases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acquisition_bases) = 'array'),
  time_precision_summary text NOT NULL CHECK (time_precision_summary IN ('NONE','INSTANT_ONLY','DATE_ONLY','MIXED')),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_revision_id uuid REFERENCES entity_source_presence_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_id, source_definition_id, revision_number),
  CHECK (primary_observation_count + related_observation_count = observation_count),
  CHECK (
    (state = 'ACTIVE'
      AND observation_count > 0
      AND num_nonnulls(first_seen_time, first_seen_date) = 1
      AND num_nonnulls(last_seen_time, last_seen_date) = 1
      AND first_node_received_at IS NOT NULL
      AND last_node_received_at IS NOT NULL
      AND time_precision_summary <> 'NONE')
    OR
    (state = 'RETRACTED'
      AND observation_count = 0
      AND primary_observation_count = 0
      AND related_observation_count = 0
      AND num_nonnulls(first_seen_time, first_seen_date, last_seen_time, last_seen_date,
                       first_node_received_at, last_node_received_at) = 0
      AND time_precision_summary = 'NONE')
  )
);

CREATE INDEX entity_source_presence_revisions_entity_idx
  ON entity_source_presence_revisions(entity_id, source_definition_id, revision_number DESC);
CREATE INDEX entity_source_presence_revisions_origin_idx
  ON entity_source_presence_revisions(upstream_origin_key_snapshot, state, entity_id);

CREATE TABLE entity_source_presence_heads (
  entity_id uuid NOT NULL REFERENCES technical_entity_registry(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  current_revision_id uuid NOT NULL REFERENCES entity_source_presence_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  first_seen_time timestamptz,
  first_seen_date date,
  last_seen_time timestamptz,
  last_seen_date date,
  first_node_received_at timestamptz,
  last_node_received_at timestamptz,
  observation_count bigint NOT NULL CHECK (observation_count >= 0),
  primary_observation_count bigint NOT NULL CHECK (primary_observation_count >= 0),
  related_observation_count bigint NOT NULL CHECK (related_observation_count >= 0),
  source_class_snapshot text NOT NULL,
  observation_basis_snapshot text NOT NULL CHECK (observation_basis_snapshot IN ('OBSERVED','REPORTED','PUBLISHED','SCORED','ENRICHED','UNKNOWN')),
  upstream_origin_key_snapshot text NOT NULL,
  semantic_contract_version_snapshot text NOT NULL,
  acquisition_bases jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acquisition_bases) = 'array'),
  time_precision_summary text NOT NULL CHECK (time_precision_summary IN ('NONE','INSTANT_ONLY','DATE_ONLY','MIXED')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(entity_id, source_definition_id),
  CHECK (primary_observation_count + related_observation_count = observation_count)
);

CREATE INDEX entity_source_presence_heads_active_entity_idx
  ON entity_source_presence_heads(entity_id, source_definition_id) WHERE state = 'ACTIVE';
CREATE INDEX entity_source_presence_heads_active_origin_idx
  ON entity_source_presence_heads(upstream_origin_key_snapshot, entity_id) WHERE state = 'ACTIVE';

CREATE TABLE entity_source_presence_inputs (
  presence_revision_id uuid NOT NULL REFERENCES entity_source_presence_revisions(id) ON DELETE RESTRICT,
  entity_observation_revision_id uuid NOT NULL REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  PRIMARY KEY(presence_revision_id, entity_observation_revision_id)
);
CREATE INDEX entity_source_presence_inputs_observation_idx
  ON entity_source_presence_inputs(entity_observation_revision_id, presence_revision_id);

CREATE OR REPLACE FUNCTION reject_node7_presence_history_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 source presence history is immutable; append a new revision instead';
END;
$$;

CREATE TRIGGER entity_source_presence_revisions_immutable_update
BEFORE UPDATE ON entity_source_presence_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_presence_history_mutation();
CREATE TRIGGER entity_source_presence_revisions_immutable_delete
BEFORE DELETE ON entity_source_presence_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_presence_history_mutation();
CREATE TRIGGER entity_source_presence_inputs_immutable_update
BEFORE UPDATE ON entity_source_presence_inputs
FOR EACH ROW EXECUTE FUNCTION reject_node7_presence_history_mutation();
CREATE TRIGGER entity_source_presence_inputs_immutable_delete
BEFORE DELETE ON entity_source_presence_inputs
FOR EACH ROW EXECUTE FUNCTION reject_node7_presence_history_mutation();

COMMIT;

BEGIN;

ALTER TABLE node7_projection_jobs
  ADD COLUMN trigger_entity_history_revision_id uuid REFERENCES entity_history_revisions(id) ON DELETE RESTRICT;

CREATE TABLE discovery_finding_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_key char(64) NOT NULL CHECK (finding_key ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  finding_type text NOT NULL CHECK (finding_type IN ('NEW_ENTITY','HISTORICAL_DISCOVERY','COMPOSITION_EXPANSION')),
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  effective_first_seen_time timestamptz,
  effective_first_seen_date date,
  time_precision text CHECK (time_precision IS NULL OR time_precision IN ('INSTANT','DATE')),
  node_discovered_at timestamptz NOT NULL,
  new_source_definition_count integer NOT NULL DEFAULT 0 CHECK (new_source_definition_count >= 0),
  new_upstream_origin_count integer NOT NULL DEFAULT 0 CHECK (new_upstream_origin_count >= 0),
  new_source_class_count integer NOT NULL DEFAULT 0 CHECK (new_source_class_count >= 0),
  new_source_definition_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(new_source_definition_keys)='array'),
  new_upstream_origin_keys jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(new_upstream_origin_keys)='array'),
  new_source_classes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(new_source_classes)='array'),
  acquisition_basis text,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_id uuid REFERENCES discovery_finding_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(effective_first_seen_time,effective_first_seen_date) <= 1),
  CHECK ((window_start IS NULL AND window_end IS NULL) OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_end > window_start)),
  UNIQUE (finding_key, revision_number)
);

CREATE INDEX discovery_finding_revisions_subject_idx
  ON discovery_finding_revisions(entity_type,entity_key,calculated_at DESC);

CREATE TABLE discovery_finding_heads (
  finding_key char(64) PRIMARY KEY CHECK (finding_key ~ '^[0-9a-f]{64}$'),
  current_revision_id uuid NOT NULL UNIQUE REFERENCES discovery_finding_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  finding_type text NOT NULL CHECK (finding_type IN ('NEW_ENTITY','HISTORICAL_DISCOVERY','COMPOSITION_EXPANSION')),
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  window_start timestamptz,
  window_end timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX discovery_finding_heads_type_window_idx
  ON discovery_finding_heads(state,finding_type,window_start DESC NULLS LAST,updated_at DESC);
CREATE INDEX discovery_finding_heads_subject_idx
  ON discovery_finding_heads(entity_type,entity_key,state,updated_at DESC);

CREATE TABLE discovery_finding_inputs (
  finding_revision_id uuid PRIMARY KEY REFERENCES discovery_finding_revisions(id) ON DELETE CASCADE,
  entity_history_revision_id uuid REFERENCES entity_history_revisions(id) ON DELETE RESTRICT,
  current_activity_bucket_revision_id uuid REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  previous_activity_bucket_revision_id uuid REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(entity_history_revision_id,current_activity_bucket_revision_id) >= 1)
);

CREATE TABLE discovery_history_projection_receipts (
  entity_history_revision_id uuid NOT NULL REFERENCES entity_history_revisions(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_history_revision_id,policy_revision_id)
);

CREATE TABLE discovery_activity_projection_receipts (
  activity_bucket_revision_id uuid NOT NULL REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_bucket_revision_id,policy_revision_id)
);

CREATE OR REPLACE FUNCTION reject_node7_discovery_revision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 discovery revisions are immutable; append a new revision instead';
END; $$;

CREATE TRIGGER discovery_finding_revisions_immutable_update
BEFORE UPDATE ON discovery_finding_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_discovery_revision_mutation();

CREATE TRIGGER discovery_finding_revisions_immutable_delete
BEFORE DELETE ON discovery_finding_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_discovery_revision_mutation();

COMMIT;

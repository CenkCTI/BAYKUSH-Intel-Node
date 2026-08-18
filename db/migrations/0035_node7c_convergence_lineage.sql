BEGIN;

ALTER TABLE node7_projection_jobs
  ADD COLUMN trigger_activity_bucket_revision_id uuid REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT;

CREATE TABLE convergence_finding_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_key char(64) NOT NULL CHECK (finding_key ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  finding_type text NOT NULL CHECK (finding_type IN (
    'SOURCE_SYSTEM_OVERLAP','MULTI_ORIGIN_CONVERGENCE','CROSS_CLASS_CONVERGENCE','CONCURRENT_MOVEMENT'
  )),
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('HOUR','DAY')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  time_precision text NOT NULL CHECK (time_precision IN ('INSTANT','DATE','MIXED')),
  source_definition_count integer NOT NULL CHECK (source_definition_count >= 0),
  upstream_origin_count integer NOT NULL CHECK (upstream_origin_count >= 0),
  source_class_count integer NOT NULL CHECK (source_class_count >= 0),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  first_observed_time timestamptz,
  last_observed_time timestamptz,
  first_observed_date date,
  last_observed_date date,
  observation_span_seconds bigint CHECK (observation_span_seconds IS NULL OR observation_span_seconds >= 0),
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_id uuid REFERENCES convergence_finding_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start),
  CHECK (num_nonnulls(first_observed_time, first_observed_date) <= 1),
  CHECK (num_nonnulls(last_observed_time, last_observed_date) <= 1),
  UNIQUE (finding_key, revision_number)
);

CREATE INDEX convergence_finding_revisions_subject_idx
  ON convergence_finding_revisions(entity_type, entity_key, window_start DESC, finding_type);

CREATE TABLE convergence_finding_heads (
  finding_key char(64) PRIMARY KEY CHECK (finding_key ~ '^[0-9a-f]{64}$'),
  current_revision_id uuid NOT NULL UNIQUE REFERENCES convergence_finding_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  finding_type text NOT NULL CHECK (finding_type IN (
    'SOURCE_SYSTEM_OVERLAP','MULTI_ORIGIN_CONVERGENCE','CROSS_CLASS_CONVERGENCE','CONCURRENT_MOVEMENT'
  )),
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('HOUR','DAY')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX convergence_finding_heads_window_idx
  ON convergence_finding_heads(state, finding_type, window_start DESC);
CREATE INDEX convergence_finding_heads_entity_idx
  ON convergence_finding_heads(entity_type, entity_key, state, window_start DESC);

CREATE TABLE convergence_finding_inputs (
  finding_revision_id uuid NOT NULL REFERENCES convergence_finding_revisions(id) ON DELETE CASCADE,
  activity_bucket_revision_id uuid NOT NULL REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  PRIMARY KEY (finding_revision_id, activity_bucket_revision_id)
);

CREATE TABLE convergence_projection_receipts (
  activity_bucket_revision_id uuid NOT NULL REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_bucket_revision_id, policy_revision_id)
);

CREATE OR REPLACE FUNCTION reject_node7_convergence_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 convergence revisions are immutable; append a new revision instead';
END;
$$;

CREATE TRIGGER convergence_finding_revisions_immutable_update
BEFORE UPDATE ON convergence_finding_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_convergence_revision_mutation();

CREATE TRIGGER convergence_finding_revisions_immutable_delete
BEFORE DELETE ON convergence_finding_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_convergence_revision_mutation();

COMMIT;

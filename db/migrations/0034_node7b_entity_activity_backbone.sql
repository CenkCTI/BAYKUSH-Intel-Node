BEGIN;

CREATE TABLE entity_activity_bucket_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE','EMPTY')),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  source_definition_count integer NOT NULL CHECK (source_definition_count >= 0),
  upstream_origin_count integer NOT NULL CHECK (upstream_origin_count >= 0),
  source_class_count integer NOT NULL CHECK (source_class_count >= 0),
  instant_observation_count integer NOT NULL CHECK (instant_observation_count >= 0),
  date_observation_count integer NOT NULL CHECK (date_observation_count >= 0),
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  supersedes_id uuid REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_end > bucket_start),
  CHECK ((state='EMPTY' AND observation_count=0) OR state='ACTIVE'),
  UNIQUE (entity_type, entity_key, resolution, bucket_start, revision_number)
);

CREATE INDEX entity_activity_bucket_revisions_lookup_idx
  ON entity_activity_bucket_revisions(entity_type, entity_key, resolution, bucket_start, revision_number DESC);

CREATE TABLE entity_activity_bucket_heads (
  entity_type text NOT NULL,
  entity_key text NOT NULL,
  resolution text NOT NULL CHECK (resolution IN ('HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('ACTIVE','EMPTY')),
  current_revision_id uuid NOT NULL UNIQUE REFERENCES entity_activity_bucket_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_key, resolution, bucket_start),
  CHECK (bucket_end > bucket_start)
);

CREATE INDEX entity_activity_bucket_heads_window_idx
  ON entity_activity_bucket_heads(resolution, bucket_start, state);

CREATE TABLE entity_activity_bucket_members (
  bucket_revision_id uuid NOT NULL REFERENCES entity_activity_bucket_revisions(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  source_key text NOT NULL,
  upstream_origin_key text NOT NULL,
  source_class text NOT NULL,
  observation_basis text NOT NULL,
  observation_count integer NOT NULL CHECK (observation_count > 0),
  instant_observation_count integer NOT NULL CHECK (instant_observation_count >= 0),
  date_observation_count integer NOT NULL CHECK (date_observation_count >= 0),
  first_observed_time timestamptz,
  last_observed_time timestamptz,
  first_observed_date date,
  last_observed_date date,
  PRIMARY KEY (bucket_revision_id, source_definition_id),
  CHECK (num_nonnulls(first_observed_time, first_observed_date) <= 1),
  CHECK (num_nonnulls(last_observed_time, last_observed_date) <= 1)
);

CREATE INDEX entity_activity_bucket_members_origin_idx
  ON entity_activity_bucket_members(upstream_origin_key, source_class);

CREATE TABLE entity_activity_bucket_inputs (
  bucket_revision_id uuid NOT NULL REFERENCES entity_activity_bucket_revisions(id) ON DELETE CASCADE,
  entity_observation_revision_id uuid NOT NULL REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  PRIMARY KEY (bucket_revision_id, entity_observation_revision_id)
);

CREATE TABLE node7_projection_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  projection_kind text NOT NULL CHECK (projection_kind IN ('ENTITY_ACTIVITY','CONVERGENCE','DISCOVERY','GEOGRAPHY')),
  subject_type text NOT NULL,
  subject_key text NOT NULL,
  resolution text CHECK (resolution IS NULL OR resolution IN ('HOUR','DAY')),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  trigger_observation_revision_id uuid REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  idempotency_key char(64) NOT NULL UNIQUE CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (window_end > window_start)
);

CREATE INDEX node7_projection_jobs_claim_idx
  ON node7_projection_jobs(projection_kind, state, available_at, lease_expires_at, created_at);

CREATE TABLE node7_projection_receipts (
  entity_observation_revision_id uuid NOT NULL REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  projection_kind text NOT NULL CHECK (projection_kind IN ('ENTITY_ACTIVITY','CONVERGENCE','DISCOVERY','GEOGRAPHY')),
  projection_scope text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_observation_revision_id, policy_revision_id, projection_kind, projection_scope)
);

CREATE OR REPLACE FUNCTION reject_node7_activity_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 activity revisions are immutable; append a new revision instead';
END;
$$;

CREATE TRIGGER entity_activity_bucket_revisions_immutable_update
BEFORE UPDATE ON entity_activity_bucket_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_activity_revision_mutation();

CREATE TRIGGER entity_activity_bucket_revisions_immutable_delete
BEFORE DELETE ON entity_activity_bucket_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_activity_revision_mutation();

COMMIT;

BEGIN;

CREATE TABLE measurement_dirty_buckets (
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE CASCADE,
  granularity text NOT NULL CHECK (granularity IN ('FIVE_MINUTES','HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  scope_key text NOT NULL DEFAULT 'GLOBAL',
  dirty_revision bigint NOT NULL DEFAULT 1 CHECK (dirty_revision > 0),
  dirty_since timestamptz NOT NULL DEFAULT now(),
  dirty_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dirty_reasons) = 'array'),
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_end > bucket_start),
  PRIMARY KEY (measurement_calculation_id, granularity, bucket_start, scope_key)
);
CREATE INDEX measurement_dirty_buckets_claim_idx ON measurement_dirty_buckets(lease_expires_at, dirty_since);

CREATE TABLE measurement_bucket_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_definition_id uuid NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE RESTRICT,
  granularity text NOT NULL CHECK (granularity IN ('FIVE_MINUTES','HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  scope_key text NOT NULL DEFAULT 'GLOBAL',
  time_axis text NOT NULL CHECK (time_axis IN ('SOURCE_EFFECTIVE_TIME','SOURCE_PUBLISHED_TIME','UPSTREAM_UPDATED_TIME','NODE_RECEIVED_TIME','SOURCE_DATASET_DATE')),
  value_numeric numeric,
  coverage_status text NOT NULL CHECK (coverage_status IN ('COMPLETE','PARTIAL','DEGRADED','NO_COVERAGE')),
  expectation_status text NOT NULL CHECK (expectation_status IN ('EXPECTED','NOT_EXPECTED','UNKNOWN')),
  data_availability text NOT NULL CHECK (data_availability IN ('AVAILABLE','PARTIAL','UNAVAILABLE','UNKNOWN')),
  acquisition_summary jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(acquisition_summary) = 'array'),
  bucket_state text NOT NULL CHECK (bucket_state IN ('PROVISIONAL','SETTLED','REVISED')),
  comparison_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(comparison_context) = 'object'),
  input_fact_count integer NOT NULL CHECK (input_fact_count >= 0),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  coverage_input_fingerprint char(64) NOT NULL CHECK (coverage_input_fingerprint ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  supersedes_revision_id uuid REFERENCES measurement_bucket_revisions(id) ON DELETE RESTRICT,
  revision_reason text NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_end > bucket_start),
  CHECK (NOT (coverage_status = 'NO_COVERAGE' AND data_availability IN ('UNAVAILABLE','UNKNOWN') AND value_numeric IS NOT NULL)),
  UNIQUE (measurement_calculation_id, granularity, bucket_start, scope_key, revision_number)
);
CREATE INDEX measurement_bucket_revisions_lookup_idx ON measurement_bucket_revisions(measurement_calculation_id, granularity, bucket_start, scope_key, revision_number DESC);
CREATE INDEX measurement_bucket_revisions_asof_idx ON measurement_bucket_revisions(measurement_calculation_id, granularity, calculated_at, bucket_start);

CREATE TABLE measurement_bucket_heads (
  measurement_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE CASCADE,
  granularity text NOT NULL CHECK (granularity IN ('FIVE_MINUTES','HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  scope_key text NOT NULL DEFAULT 'GLOBAL',
  current_revision_id uuid NOT NULL REFERENCES measurement_bucket_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_end > bucket_start),
  PRIMARY KEY (measurement_calculation_id, granularity, bucket_start, scope_key)
);
CREATE INDEX measurement_bucket_heads_range_idx ON measurement_bucket_heads(measurement_calculation_id, granularity, bucket_start, bucket_end);

CREATE TABLE measurement_distribution_values (
  bucket_revision_id uuid NOT NULL REFERENCES measurement_bucket_revisions(id) ON DELETE CASCADE,
  dimension_key text NOT NULL,
  dimension_value text NOT NULL,
  count_value bigint NOT NULL CHECK (count_value >= 0),
  share numeric CHECK (share IS NULL OR (share >= 0 AND share <= 1)),
  rank integer NOT NULL CHECK (rank > 0),
  is_other boolean NOT NULL DEFAULT false,
  PRIMARY KEY (bucket_revision_id, dimension_key, rank),
  UNIQUE (bucket_revision_id, dimension_key, dimension_value)
);
CREATE INDEX measurement_distribution_lookup_idx ON measurement_distribution_values(bucket_revision_id, dimension_key, rank);

CREATE OR REPLACE FUNCTION reject_node3_bucket_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NODE-3 measurement bucket revisions are immutable; append a new revision instead'; END; $$;
CREATE TRIGGER measurement_bucket_revisions_immutable_update BEFORE UPDATE ON measurement_bucket_revisions FOR EACH ROW EXECUTE FUNCTION reject_node3_bucket_revision_update();
CREATE TRIGGER measurement_distribution_values_immutable_update BEFORE UPDATE ON measurement_distribution_values FOR EACH ROW EXECUTE FUNCTION reject_node3_bucket_revision_update();

COMMIT;

BEGIN;

CREATE TABLE measurement_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_key text NOT NULL,
  contract_version text NOT NULL,
  domain text NOT NULL,
  display_label text NOT NULL,
  description text NOT NULL,
  unit text NOT NULL,
  value_kind text NOT NULL CHECK (value_kind IN ('COUNT','GAUGE','DISTRIBUTION')),
  primary_time_axis text NOT NULL CHECK (primary_time_axis IN (
    'SOURCE_EFFECTIVE_TIME','SOURCE_PUBLISHED_TIME','UPSTREAM_UPDATED_TIME','NODE_RECEIVED_TIME','SOURCE_DATASET_DATE'
  )),
  time_precision text NOT NULL CHECK (time_precision IN ('INSTANT','DATE')),
  source_scope jsonb NOT NULL CHECK (jsonb_typeof(source_scope) = 'array'),
  record_kind_scope jsonb NOT NULL CHECK (jsonb_typeof(record_kind_scope) = 'array'),
  supported_granularities jsonb NOT NULL CHECK (jsonb_typeof(supported_granularities) = 'array'),
  supported_dimensions jsonb NOT NULL CHECK (jsonb_typeof(supported_dimensions) = 'array'),
  coverage_policy text NOT NULL,
  zero_policy text NOT NULL,
  acquisition_policy text NOT NULL,
  comparison_policy jsonb NOT NULL CHECK (jsonb_typeof(comparison_policy) = 'object'),
  population_profile jsonb,
  change_feed_policy text NOT NULL CHECK (change_feed_policy IN ('NONE','FACT','BUCKET_SUMMARY')),
  visibility text NOT NULL CHECK (visibility IN ('PUBLIC','INTERNAL')),
  represents text NOT NULL,
  does_not_represent text NOT NULL,
  contract_sha256 char(64) NOT NULL CHECK (contract_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (measurement_key, contract_version)
);

CREATE TABLE measurement_calculation_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  measurement_definition_id uuid NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
  calculation_version text NOT NULL,
  projector_key text NOT NULL,
  aggregation_kind text NOT NULL CHECK (aggregation_kind IN (
    'COUNT_EVENTS','COUNT_DISTINCT','FIRST_SEEN_DISTINCT','SNAPSHOT_LAST',
    'SNAPSHOT_LAST_CARRY_FORWARD','DATASET_COUNT','DISTRIBUTION_COUNT'
  )),
  calculation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(calculation_metadata) = 'object'),
  calculation_sha256 char(64) NOT NULL CHECK (calculation_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (measurement_definition_id, calculation_version)
);

CREATE TABLE measurement_definition_heads (
  measurement_key text PRIMARY KEY,
  active_definition_id uuid NOT NULL REFERENCES measurement_definitions(id) ON DELETE RESTRICT,
  active_calculation_id uuid NOT NULL REFERENCES measurement_calculation_versions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX measurement_definitions_domain_idx
  ON measurement_definitions(domain, visibility, measurement_key);
CREATE INDEX measurement_calculation_definition_idx
  ON measurement_calculation_versions(measurement_definition_id, calculation_version);

CREATE OR REPLACE FUNCTION reject_node3_contract_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-3 measurement contracts and calculation versions are immutable; append a new version instead';
END;
$$;

CREATE TRIGGER measurement_definitions_immutable_update
BEFORE UPDATE ON measurement_definitions
FOR EACH ROW EXECUTE FUNCTION reject_node3_contract_update();

CREATE TRIGGER measurement_calculation_versions_immutable_update
BEFORE UPDATE ON measurement_calculation_versions
FOR EACH ROW EXECUTE FUNCTION reject_node3_contract_update();

COMMIT;

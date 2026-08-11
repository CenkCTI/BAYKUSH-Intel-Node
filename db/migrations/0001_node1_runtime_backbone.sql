BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE source_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_key text NOT NULL UNIQUE,
  display_name text NOT NULL,
  provider_name text NOT NULL,
  upstream_origin_key text NOT NULL,
  source_class text NOT NULL CHECK (source_class IN (
    'VULNERABILITY_DATABASE','EXPLOITED_VULNERABILITY_CATALOG','EXPLOIT_PROBABILITY',
    'IOC_SHARING','MALWARE_SAMPLE_REPOSITORY','OFFICIAL_ADVISORY','CERT_CSIRT_REPORTING',
    'THREAT_RESEARCH','CAMPAIGN_REPORTING','INFRASTRUCTURE_TELEMETRY','DNS_OBSERVATION',
    'CERTIFICATE_OBSERVATION','ROUTING_TELEMETRY','CONTEXT_KNOWLEDGE','UNKNOWN'
  )),
  observation_basis text NOT NULL CHECK (observation_basis IN ('OBSERVED','REPORTED','PUBLISHED','SCORED','ENRICHED','UNKNOWN')),
  authority_type text NOT NULL,
  collection_mode text NOT NULL CHECK (collection_mode IN ('POLL','PAGED_POLL','SNAPSHOT','STREAM')),
  default_poll_interval_seconds integer CHECK (default_poll_interval_seconds IS NULL OR default_poll_interval_seconds > 0),
  minimum_poll_interval_seconds integer CHECK (minimum_poll_interval_seconds IS NULL OR minimum_poll_interval_seconds > 0),
  supports_historical_retrieval boolean NOT NULL DEFAULT false,
  recovery_strategy text NOT NULL CHECK (recovery_strategy IN ('HISTORICAL_QUERY','CURSOR_CATCHUP','SNAPSHOT_RECONSTRUCTION','LIVE_ONLY')),
  historical_max_window_seconds bigint CHECK (historical_max_window_seconds IS NULL OR historical_max_window_seconds > 0),
  requires_auth boolean NOT NULL DEFAULT false,
  credential_kind text,
  adapter_version text NOT NULL,
  semantic_contract_version text NOT NULL,
  license_class text NOT NULL,
  commercial_use_status text NOT NULL CHECK (commercial_use_status IN ('UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE')),
  redistribution_status text NOT NULL CHECK (redistribution_status IN ('UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE')),
  attribution_requirement text,
  terms_reference text,
  represents text NOT NULL,
  does_not_represent text NOT NULL,
  enabled_by_default boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_schedule_state (
  source_definition_id uuid PRIMARY KEY REFERENCES source_definitions(id) ON DELETE CASCADE,
  next_due_at timestamptz NOT NULL,
  last_enqueued_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collection_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id),
  trigger text NOT NULL CHECK (trigger IN ('SCHEDULED','MANUAL','TEST','RECOVERY','BOOTSTRAP')),
  purpose text NOT NULL CHECK (purpose IN ('LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','HISTORICAL_BACKFILL','RESYNC','REPAIR')),
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','PARTIAL','CANCELLED')),
  idempotency_key text NOT NULL UNIQUE,
  scheduled_for timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  work_units_succeeded integer NOT NULL DEFAULT 0 CHECK (work_units_succeeded >= 0),
  raw_records_accepted bigint NOT NULL DEFAULT 0 CHECK (raw_records_accepted >= 0),
  raw_records_inserted bigint NOT NULL DEFAULT 0 CHECK (raw_records_inserted >= 0),
  failure_code text,
  failure_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX collection_runs_claim_idx
  ON collection_runs(state, lease_expires_at, created_at);
CREATE INDEX collection_runs_source_state_idx
  ON collection_runs(source_definition_id, state);

CREATE TABLE collection_work_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  work_key text NOT NULL,
  descriptor jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  accepted_record_count integer NOT NULL DEFAULT 0 CHECK (accepted_record_count >= 0),
  inserted_record_count integer NOT NULL DEFAULT 0 CHECK (inserted_record_count >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, ordinal),
  UNIQUE (run_id, work_key)
);

CREATE INDEX collection_work_units_claim_idx
  ON collection_work_units(run_id, state, lease_expires_at, ordinal);

CREATE TABLE source_checkpoints (
  source_definition_id uuid PRIMARY KEY REFERENCES source_definitions(id) ON DELETE CASCADE,
  checkpoint_schema_version text NOT NULL,
  checkpoint jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_run_id uuid REFERENCES collection_runs(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE raw_source_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id),
  collection_run_id uuid NOT NULL REFERENCES collection_runs(id),
  collection_work_unit_id uuid NOT NULL REFERENCES collection_work_units(id),
  source_record_id text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  effective_at timestamptz,
  upstream_updated_at timestamptz,
  source_url text,
  adapter_version text NOT NULL,
  source_schema_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_definition_id, source_record_id, payload_sha256)
);

CREATE INDEX raw_source_records_source_record_idx
  ON raw_source_records(source_definition_id, source_record_id, received_at DESC);
CREATE INDEX raw_source_records_received_idx
  ON raw_source_records(received_at DESC);
CREATE INDEX raw_source_records_effective_idx
  ON raw_source_records(effective_at DESC) WHERE effective_at IS NOT NULL;

CREATE OR REPLACE FUNCTION reject_raw_source_record_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'raw_source_records are immutable; append a new source revision instead';
END;
$$;

CREATE TRIGGER raw_source_records_immutable_update
BEFORE UPDATE ON raw_source_records
FOR EACH ROW EXECUTE FUNCTION reject_raw_source_record_update();

CREATE TABLE source_health (
  source_definition_id uuid PRIMARY KEY REFERENCES source_definitions(id) ON DELETE CASCADE,
  health_status text NOT NULL DEFAULT 'UNKNOWN' CHECK (health_status IN ('UNKNOWN','HEALTHY','DEGRADED','FAILED','PAUSED')),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  latest_failure_code text,
  latest_failure_message text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE runtime_heartbeats (
  component text NOT NULL CHECK (component IN ('API','SCHEDULER','WORKER')),
  instance_id text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (component, instance_id)
);

INSERT INTO source_definitions (
  source_key, display_name, provider_name, upstream_origin_key,
  source_class, observation_basis, authority_type, collection_mode,
  default_poll_interval_seconds, supports_historical_retrieval, recovery_strategy,
  requires_auth, adapter_version, semantic_contract_version, license_class,
  commercial_use_status, redistribution_status, represents, does_not_represent,
  enabled_by_default, enabled
) VALUES (
  'TEST_SYNTHETIC', 'Deterministic Test Source', 'BAYKUSH', 'BAYKUSH_TEST',
  'UNKNOWN', 'UNKNOWN', 'internal-test', 'PAGED_POLL',
  60, false, 'LIVE_ONLY',
  false, 'node-1-test-v1', 'node-1-sem-v1', 'INTERNAL_TEST',
  'NOT_APPLICABLE', 'NOT_APPLICABLE',
  'Deterministic synthetic records used to test BAYKUSH Node collection mechanics.',
  'Real cyber activity, external observations, attacks, victims, malware prevalence, or threat level.',
  false, false
) ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state (source_definition_id, next_due_at)
SELECT id, now()
FROM source_definitions
WHERE source_key = 'TEST_SYNTHETIC'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health (source_definition_id, health_status)
SELECT id, 'PAUSED'
FROM source_definitions
WHERE source_key = 'TEST_SYNTHETIC'
ON CONFLICT (source_definition_id) DO NOTHING;

COMMIT;

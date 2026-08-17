BEGIN;

ALTER TABLE runtime_heartbeats DROP CONSTRAINT runtime_heartbeats_component_check;
ALTER TABLE runtime_heartbeats ADD CONSTRAINT runtime_heartbeats_component_check
  CHECK (component IN ('API','SCHEDULER','WORKER','NORMALIZER','MEASUREMENT','BACKFILL','STREAM_WORKER'));

ALTER TABLE measurement_definitions DROP CONSTRAINT measurement_definitions_primary_time_axis_check;
ALTER TABLE measurement_definitions ADD CONSTRAINT measurement_definitions_primary_time_axis_check
  CHECK (primary_time_axis IN (
    'SOURCE_EFFECTIVE_TIME','SOURCE_PUBLISHED_TIME','UPSTREAM_UPDATED_TIME',
    'NODE_RECEIVED_TIME','SOURCE_DATASET_DATE','SOURCE_OBSERVED_TIME'
  ));

ALTER TABLE measurement_dirty_buckets DROP CONSTRAINT measurement_dirty_buckets_granularity_check;
ALTER TABLE measurement_dirty_buckets ADD CONSTRAINT measurement_dirty_buckets_granularity_check
  CHECK (granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY'));

ALTER TABLE measurement_bucket_revisions DROP CONSTRAINT measurement_bucket_revisions_granularity_check;
ALTER TABLE measurement_bucket_revisions ADD CONSTRAINT measurement_bucket_revisions_granularity_check
  CHECK (granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY'));
ALTER TABLE measurement_bucket_revisions DROP CONSTRAINT measurement_bucket_revisions_time_axis_check;
ALTER TABLE measurement_bucket_revisions ADD CONSTRAINT measurement_bucket_revisions_time_axis_check
  CHECK (time_axis IN (
    'SOURCE_EFFECTIVE_TIME','SOURCE_PUBLISHED_TIME','UPSTREAM_UPDATED_TIME',
    'NODE_RECEIVED_TIME','SOURCE_DATASET_DATE','SOURCE_OBSERVED_TIME'
  ));

ALTER TABLE measurement_bucket_heads DROP CONSTRAINT measurement_bucket_heads_granularity_check;
ALTER TABLE measurement_bucket_heads ADD CONSTRAINT measurement_bucket_heads_granularity_check
  CHECK (granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY'));

ALTER TABLE source_coverage_bucket_revisions DROP CONSTRAINT source_coverage_bucket_revisions_granularity_check;
ALTER TABLE source_coverage_bucket_revisions ADD CONSTRAINT source_coverage_bucket_revisions_granularity_check
  CHECK (granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY'));
ALTER TABLE source_coverage_bucket_heads DROP CONSTRAINT source_coverage_bucket_heads_granularity_check;
ALTER TABLE source_coverage_bucket_heads ADD CONSTRAINT source_coverage_bucket_heads_granularity_check
  CHECK (granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY'));
ALTER TABLE source_coverage_dirty_buckets DROP CONSTRAINT source_coverage_dirty_buckets_granularity_check;
ALTER TABLE source_coverage_dirty_buckets ADD CONSTRAINT source_coverage_dirty_buckets_granularity_check
  CHECK (granularity IN ('ONE_MINUTE','FIVE_MINUTES','HOUR','DAY'));

INSERT INTO source_definitions(
  source_key, display_name, provider_name, upstream_origin_key,
  source_class, observation_basis, authority_type, collection_mode,
  default_poll_interval_seconds, minimum_poll_interval_seconds,
  supports_historical_retrieval, recovery_strategy, historical_max_window_seconds,
  requires_auth, auth_requirement, credential_kind, adapter_version, semantic_contract_version,
  license_class, commercial_use_status, redistribution_status,
  attribution_requirement, terms_reference, represents, does_not_represent,
  enabled_by_default, enabled
) VALUES (
  'RIPE_RIS_BGP', 'RIPE RIS BGP', 'RIPE NCC', 'RIPE_RIS',
  'ROUTING_TELEMETRY', 'OBSERVED', 'ROUTING_OBSERVATION_PROVIDER', 'STREAM',
  NULL, NULL, true, 'HISTORICAL_QUERY', 604800,
  false, 'NONE', NULL, 'ripe-ris-live-v1', 'ripe-ris-routing-semantics-v1',
  'RIPE_RIS_TERMS', 'RESTRICTED', 'RESTRICTED',
  'Retain RIPE NCC / Routing Information Service attribution and do not imply RIPE NCC endorsement.',
  'https://www.ripe.net/analyse/internet-measurements/routing-information-service-ris/',
  'BGP routing messages observed by the configured RIPE RIS route-collector population during the stated interval.',
  'Global Internet routing totality, cyberattack count, Internet outage count, BGP hijack verdict, malicious routing, attacker origin, victim identity, business impact, risk, severity, or global cyber threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='RIPE_RIS_BGP'
ON CONFLICT (source_definition_id) DO NOTHING;
INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='RIPE_RIS_BGP'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_admission_revisions(
  source_definition_id, revision_number, policy_version, admission_status,
  value_question, official_access_reference, terms_reference, terms_checked_at,
  review_due_at, license_class, commercial_use_status, redistribution_status,
  raw_retention_status, canonical_retention_status, derived_data_status,
  public_display_status, attribution_requirement, collection_allowed,
  canonical_projection_allowed, measurement_projection_allowed, operator_constraints,
  admission_sha256, supersedes_revision_id, reviewed_at
)
SELECT d.id, 1, 'ripe-ris-admission-v1', 'ADMITTED',
  'What routing changes are observed by the configured RIPE RIS route-collector population?',
  'https://ris-live.ripe.net/',
  'https://www.ripe.net/analyse/internet-measurements/routing-information-service-ris/',
  '2026-08-15T00:00:00Z'::timestamptz,
  '2026-11-15T00:00:00Z'::timestamptz,
  'RIPE_RIS_TERMS', 'RESTRICTED', 'RESTRICTED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'RESTRICTED',
  'Retain RIPE NCC / RIS attribution and review current commercial-use terms before commercial redistribution or public derived-data display.',
  true, true, true,
  'Use only the fixed RIPE RIS Live endpoint and official RIS MRT archives. Routing observations are measurements, not attack/outage/hijack verdicts. Observer population changes must be versioned and comparison-gated.',
  repeat('0',64)::char(64), NULL, '2026-08-15T00:00:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='RIPE_RIS_BGP'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

CREATE TABLE stream_capture_profile_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  profile_key text NOT NULL,
  profile_version text NOT NULL,
  effective_from timestamptz NOT NULL,
  retired_at timestamptz,
  rrc_set jsonb NOT NULL CHECK (jsonb_typeof(rrc_set)='array'),
  subscription jsonb NOT NULL CHECK (jsonb_typeof(subscription)='object'),
  rrc_set_sha256 char(64) NOT NULL CHECK (rrc_set_sha256 ~ '^[0-9a-f]{64}$'),
  subscription_sha256 char(64) NOT NULL CHECK (subscription_sha256 ~ '^[0-9a-f]{64}$'),
  contract_sha256 char(64) NOT NULL CHECK (contract_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_definition_id, profile_key, profile_version),
  CHECK (retired_at IS NULL OR retired_at > effective_from)
);

CREATE TABLE stream_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  capture_profile_revision_id uuid REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  runtime_instance_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('CONNECTING','CONNECTED','STREAMING','DRAINING','CLOSED','FAILED')),
  started_at timestamptz NOT NULL DEFAULT now(),
  connected_at timestamptz,
  subscribed_at timestamptz,
  ended_at timestamptz,
  reconnect_attempt integer NOT NULL DEFAULT 0 CHECK (reconnect_attempt >= 0),
  message_count bigint NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  segment_count bigint NOT NULL DEFAULT 0 CHECK (segment_count >= 0),
  received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),
  last_source_observed_at timestamptz,
  last_node_received_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stream_sessions_source_started_idx ON stream_sessions(source_definition_id, started_at DESC);

CREATE TABLE stream_session_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stream_session_id uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN (
    'CONNECTED','SUBSCRIBED','RRC_LIST_RECEIVED','RRC_LIST_CHANGED','PROVIDER_ERROR',
    'PROVIDER_DISCONNECT','BACKPRESSURE_LIMIT','DB_UNAVAILABLE','SCHEMA_REJECTION',
    'RECONNECT_SCHEDULED','DRAIN_REQUESTED','CLOSED'
  )),
  event_at timestamptz NOT NULL DEFAULT now(),
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object')
);
CREATE INDEX stream_session_events_session_time_idx ON stream_session_events(stream_session_id,event_at);

CREATE OR REPLACE FUNCTION reject_node6_stream_contract_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NODE-6 stream contract revisions are immutable; append a new revision instead'; END; $$;
CREATE TRIGGER stream_capture_profile_revisions_immutable_update
BEFORE UPDATE ON stream_capture_profile_revisions FOR EACH ROW EXECUTE FUNCTION reject_node6_stream_contract_update();

COMMIT;

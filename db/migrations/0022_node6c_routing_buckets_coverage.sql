BEGIN;

CREATE TABLE routing_minute_bucket_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  capture_profile_revision_id uuid REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  update_message_count bigint NOT NULL CHECK (update_message_count >= 0),
  announcement_prefix_event_count bigint NOT NULL CHECK (announcement_prefix_event_count >= 0),
  withdrawal_prefix_event_count bigint NOT NULL CHECK (withdrawal_prefix_event_count >= 0),
  announced_prefixes jsonb NOT NULL CHECK (jsonb_typeof(announced_prefixes)='array'),
  withdrawn_prefixes jsonb NOT NULL CHECK (jsonb_typeof(withdrawn_prefixes)='array'),
  all_prefixes jsonb NOT NULL CHECK (jsonb_typeof(all_prefixes)='array'),
  origin_asns jsonb NOT NULL CHECK (jsonb_typeof(origin_asns)='array'),
  peer_asns jsonb NOT NULL CHECK (jsonb_typeof(peer_asns)='array'),
  rrcs jsonb NOT NULL CHECK (jsonb_typeof(rrcs)='array'),
  coverage_status text NOT NULL CHECK (coverage_status IN ('COMPLETE','PARTIAL','DEGRADED','NO_COVERAGE')),
  data_availability text NOT NULL CHECK (data_availability IN ('AVAILABLE','PARTIAL','UNAVAILABLE','UNKNOWN')),
  acquisition_basis text NOT NULL CHECK (acquisition_basis IN ('LIVE_STREAM','MRT_RECOVERY','HISTORICAL_BACKFILL')),
  input_segment_count integer NOT NULL CHECK (input_segment_count >= 0),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  supersedes_revision_id uuid REFERENCES routing_minute_bucket_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_end = bucket_start + interval '1 minute'),
  UNIQUE(source_definition_id,bucket_start,revision_number)
);
CREATE INDEX routing_minute_bucket_revisions_lookup_idx ON routing_minute_bucket_revisions(source_definition_id,bucket_start,revision_number DESC);

CREATE TABLE routing_minute_bucket_heads (
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  current_revision_id uuid NOT NULL REFERENCES routing_minute_bucket_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_definition_id,bucket_start),
  CHECK (bucket_end = bucket_start + interval '1 minute')
);

CREATE TABLE stream_coverage_interval_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  capture_profile_revision_id uuid REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  interval_start timestamptz NOT NULL,
  interval_end timestamptz NOT NULL,
  connection_state text NOT NULL CHECK (connection_state IN ('CONNECTED','DISCONNECTED','PARTIAL','UNKNOWN')),
  subscription_state text NOT NULL CHECK (subscription_state IN ('ACKNOWLEDGED','NOT_ACKNOWLEDGED','PARTIAL','UNKNOWN')),
  expected_rrc_count integer NOT NULL DEFAULT 0 CHECK (expected_rrc_count >= 0),
  observed_rrc_count integer NOT NULL DEFAULT 0 CHECK (observed_rrc_count >= 0),
  provider_error_count integer NOT NULL DEFAULT 0 CHECK (provider_error_count >= 0),
  parse_rejection_count integer NOT NULL DEFAULT 0 CHECK (parse_rejection_count >= 0),
  backpressure_loss boolean NOT NULL DEFAULT false,
  coverage_status text NOT NULL CHECK (coverage_status IN ('COMPLETE','PARTIAL','DEGRADED','NO_COVERAGE')),
  data_availability text NOT NULL CHECK (data_availability IN ('AVAILABLE','PARTIAL','UNAVAILABLE','UNKNOWN')),
  acquisition_basis text NOT NULL CHECK (acquisition_basis IN ('LIVE_STREAM','MRT_RECOVERY','HISTORICAL_BACKFILL')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes)='array'),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  supersedes_revision_id uuid REFERENCES stream_coverage_interval_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (interval_end > interval_start),
  UNIQUE(source_definition_id,interval_start,interval_end,revision_number)
);

CREATE TABLE stream_coverage_interval_heads (
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  interval_start timestamptz NOT NULL,
  interval_end timestamptz NOT NULL,
  current_revision_id uuid NOT NULL REFERENCES stream_coverage_interval_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_definition_id,interval_start,interval_end),
  CHECK (interval_end > interval_start)
);

CREATE TABLE stream_recovery_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  requested_from timestamptz NOT NULL,
  requested_to timestamptz NOT NULL,
  rrc_set jsonb NOT NULL CHECK (jsonb_typeof(rrc_set)='array'),
  reason text NOT NULL,
  status text NOT NULL CHECK (status IN ('PLANNED','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  segments_planned integer NOT NULL DEFAULT 0 CHECK (segments_planned >= 0),
  segments_completed integer NOT NULL DEFAULT 0 CHECK (segments_completed >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_to > requested_from)
);

CREATE TRIGGER routing_minute_bucket_revisions_immutable_update
BEFORE UPDATE ON routing_minute_bucket_revisions FOR EACH ROW EXECUTE FUNCTION reject_node6_stream_contract_update();
CREATE TRIGGER stream_coverage_interval_revisions_immutable_update
BEFORE UPDATE ON stream_coverage_interval_revisions FOR EACH ROW EXECUTE FUNCTION reject_node6_stream_contract_update();

COMMIT;

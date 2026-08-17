BEGIN;

ALTER TABLE runtime_heartbeats DROP CONSTRAINT runtime_heartbeats_component_check;
ALTER TABLE runtime_heartbeats ADD CONSTRAINT runtime_heartbeats_component_check
  CHECK (component IN ('API','SCHEDULER','WORKER','NORMALIZER','MEASUREMENT','BACKFILL','STREAM_WORKER','RECOVERY_WORKER'));

ALTER TABLE stream_recovery_requests DROP CONSTRAINT stream_recovery_requests_status_check;
ALTER TABLE stream_recovery_requests ADD CONSTRAINT stream_recovery_requests_status_check
  CHECK (status IN ('PLANNED','QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED'));

ALTER TABLE stream_recovery_segments DROP CONSTRAINT stream_recovery_segments_state_check;
ALTER TABLE stream_recovery_segments ADD CONSTRAINT stream_recovery_segments_state_check
  CHECK (state IN ('PLANNED','FETCHING','DOWNLOADED','VERIFYING','DECODING','DECODED','PROJECTING','PROJECTED','FAILED','CANCELLED'));

CREATE TABLE stream_recovery_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_revision text NOT NULL UNIQUE,
  automatic_gap_max_seconds integer NOT NULL CHECK (automatic_gap_max_seconds > 0),
  manual_request_max_seconds integer NOT NULL CHECK (manual_request_max_seconds > 0),
  hard_max_segments integer NOT NULL CHECK (hard_max_segments BETWEEN 1 AND 10000),
  download_concurrency integer NOT NULL CHECK (download_concurrency BETWEEN 1 AND 16),
  decoder_concurrency integer NOT NULL CHECK (decoder_concurrency BETWEEN 1 AND 8),
  projection_concurrency integer NOT NULL CHECK (projection_concurrency BETWEEN 1 AND 8),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  archive_settle_seconds integer NOT NULL CHECK (archive_settle_seconds >= 0),
  policy_sha256 char(64) NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO stream_recovery_policy_revisions(
  policy_revision, automatic_gap_max_seconds, manual_request_max_seconds,
  hard_max_segments, download_concurrency, decoder_concurrency, projection_concurrency,
  max_attempts, archive_settle_seconds, policy_sha256
) VALUES (
  'NODE6_2_RECOVERY_POLICY_V1', 1800, 21600, 10000, 2, 1, 1, 4, 900,
  encode(digest('NODE6_2_RECOVERY_POLICY_V1|1800|21600|10000|2|1|1|4|900','sha256'),'hex')
) ON CONFLICT (policy_revision) DO NOTHING;

ALTER TABLE stream_recovery_requests
  ADD COLUMN target_capture_profile_revision_id uuid REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  ADD COLUMN policy_revision text NOT NULL DEFAULT 'NODE6_2_RECOVERY_POLICY_V1',
  ADD COLUMN plan_fingerprint char(64) CHECK (plan_fingerprint IS NULL OR plan_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  ADD COLUMN automatic boolean NOT NULL DEFAULT false,
  ADD COLUMN trigger_reason text,
  ADD COLUMN created_by text;

CREATE UNIQUE INDEX stream_recovery_requests_plan_uq
  ON stream_recovery_requests(plan_fingerprint)
  WHERE plan_fingerprint IS NOT NULL AND status <> 'CANCELLED';
CREATE INDEX stream_recovery_requests_status_priority_idx
  ON stream_recovery_requests(status, priority, requested_from);

CREATE TABLE stream_recovery_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_segment_id uuid NOT NULL REFERENCES stream_recovery_segments(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  rrc text NOT NULL CHECK (rrc ~ '^rrc[0-9]{2}$'),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://data[.]ris[.]ripe[.]net/rrc[0-9]{2}/[0-9]{4}[.][0-9]{2}/update[.][0-9]{8}[.][0-9]{4}[.]gz$'),
  sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes > 0),
  http_status integer NOT NULL CHECK (http_status BETWEEN 200 AND 599),
  etag text,
  last_modified text,
  staging_key text NOT NULL CHECK (staging_key !~ '(^|/)[.][.](/|$)' AND staging_key !~ '^/'),
  staging_status text NOT NULL DEFAULT 'READY' CHECK (staging_status IN ('READY','EXPIRED','MISSING')),
  downloaded_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(recovery_segment_id, sha256),
  CHECK (window_end = window_start + interval '5 minutes'),
  CHECK (expires_at > downloaded_at)
);
CREATE INDEX stream_recovery_artifacts_expiry_idx ON stream_recovery_artifacts(staging_status, expires_at);

CREATE TABLE stream_recovery_decoder_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_segment_id uuid NOT NULL REFERENCES stream_recovery_segments(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES stream_recovery_artifacts(id) ON DELETE RESTRICT,
  decoder_name text NOT NULL,
  decoder_version text NOT NULL,
  decoder_upstream_tag text NOT NULL,
  decoder_upstream_commit char(40) NOT NULL CHECK (decoder_upstream_commit ~ '^[0-9a-f]{40}$'),
  decoder_binary_sha256 char(64) NOT NULL CHECK (decoder_binary_sha256 ~ '^[0-9a-f]{64}$'),
  decoder_image_digest text,
  decoder_contract_version text NOT NULL,
  arguments jsonb NOT NULL CHECK (jsonb_typeof(arguments)='array'),
  artifact_sha256 char(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  records_read bigint NOT NULL DEFAULT 0 CHECK (records_read >= 0),
  updates_decoded bigint NOT NULL DEFAULT 0 CHECK (updates_decoded >= 0),
  records_ignored bigint NOT NULL DEFAULT 0 CHECK (records_ignored >= 0),
  records_rejected bigint NOT NULL DEFAULT 0 CHECK (records_rejected >= 0),
  output_sha256 char(64) CHECK (output_sha256 IS NULL OR output_sha256 ~ '^[0-9a-f]{64}$'),
  exit_code integer,
  failure_code text,
  failure_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stream_recovery_decoder_runs_segment_idx ON stream_recovery_decoder_runs(recovery_segment_id, started_at DESC);

ALTER TABLE stream_recovery_segments
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN claimed_by text,
  ADD COLUMN lease_until timestamptz,
  ADD COLUMN next_retry_at timestamptz,
  ADD COLUMN artifact_id uuid REFERENCES stream_recovery_artifacts(id) ON DELETE SET NULL,
  ADD COLUMN decoder_run_id uuid REFERENCES stream_recovery_decoder_runs(id) ON DELETE SET NULL,
  ADD COLUMN last_failure_code text;
CREATE INDEX stream_recovery_segments_claim_idx
  ON stream_recovery_segments(state, next_retry_at, lease_until, window_start);

CREATE TABLE stream_recovery_attempt_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_segment_id uuid NOT NULL REFERENCES stream_recovery_segments(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number >= 1),
  event_type text NOT NULL CHECK (event_type IN (
    'CLAIMED','FETCH_STARTED','DOWNLOADED','ARTIFACT_CHANGED','VERIFY_STARTED','DECODE_STARTED',
    'DECODED','PROJECT_STARTED','PROJECTED','RETRY_SCHEDULED','FAILED','CANCELLED'
  )),
  failure_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details)='object'),
  event_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stream_recovery_attempt_events_segment_idx ON stream_recovery_attempt_events(recovery_segment_id,event_at);

CREATE TABLE routing_recovery_minute_deltas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_segment_id uuid NOT NULL REFERENCES stream_recovery_segments(id) ON DELETE CASCADE,
  artifact_id uuid NOT NULL REFERENCES stream_recovery_artifacts(id) ON DELETE RESTRICT,
  decoder_run_id uuid NOT NULL REFERENCES stream_recovery_decoder_runs(id) ON DELETE RESTRICT,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  target_capture_profile_revision_id uuid NOT NULL REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  rrc text NOT NULL CHECK (rrc ~ '^rrc[0-9]{2}$'),
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
  ipv4_prefix_events bigint NOT NULL CHECK (ipv4_prefix_events >= 0),
  ipv6_prefix_events bigint NOT NULL CHECK (ipv6_prefix_events >= 0),
  decoded_record_count bigint NOT NULL CHECK (decoded_record_count >= 0),
  ignored_record_count bigint NOT NULL CHECK (ignored_record_count >= 0),
  rejected_record_count bigint NOT NULL CHECK (rejected_record_count >= 0),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(recovery_segment_id, bucket_start),
  CHECK (bucket_end = bucket_start + interval '1 minute')
);
CREATE INDEX routing_recovery_minute_deltas_bucket_idx ON routing_recovery_minute_deltas(source_definition_id,bucket_start);

CREATE TABLE routing_recovery_minute_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  target_capture_profile_revision_id uuid NOT NULL REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  expected_rrc_count integer NOT NULL CHECK (expected_rrc_count > 0),
  projected_rrc_count integer NOT NULL CHECK (projected_rrc_count >= 0),
  expected_rrcs jsonb NOT NULL CHECK (jsonb_typeof(expected_rrcs)='array'),
  projected_rrcs jsonb NOT NULL CHECK (jsonb_typeof(projected_rrcs)='array'),
  missing_rrcs jsonb NOT NULL CHECK (jsonb_typeof(missing_rrcs)='array'),
  status text NOT NULL CHECK (status IN ('COMPLETE','PARTIAL','DEGRADED','FAILED')),
  data_availability text NOT NULL CHECK (data_availability IN ('AVAILABLE','PARTIAL','UNAVAILABLE')),
  recovery_request_ids jsonb NOT NULL CHECK (jsonb_typeof(recovery_request_ids)='array'),
  update_message_count bigint NOT NULL CHECK (update_message_count >= 0),
  announcement_prefix_event_count bigint NOT NULL CHECK (announcement_prefix_event_count >= 0),
  withdrawal_prefix_event_count bigint NOT NULL CHECK (withdrawal_prefix_event_count >= 0),
  announced_prefixes jsonb NOT NULL CHECK (jsonb_typeof(announced_prefixes)='array'),
  withdrawn_prefixes jsonb NOT NULL CHECK (jsonb_typeof(withdrawn_prefixes)='array'),
  all_prefixes jsonb NOT NULL CHECK (jsonb_typeof(all_prefixes)='array'),
  origin_asns jsonb NOT NULL CHECK (jsonb_typeof(origin_asns)='array'),
  peer_asns jsonb NOT NULL CHECK (jsonb_typeof(peer_asns)='array'),
  ipv4_prefix_events bigint NOT NULL CHECK (ipv4_prefix_events >= 0),
  ipv6_prefix_events bigint NOT NULL CHECK (ipv6_prefix_events >= 0),
  artifact_fingerprint char(64) NOT NULL CHECK (artifact_fingerprint ~ '^[0-9a-f]{64}$'),
  decoder_fingerprint char(64) NOT NULL CHECK (decoder_fingerprint ~ '^[0-9a-f]{64}$'),
  projection_fingerprint char(64) NOT NULL CHECK (projection_fingerprint ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number >= 1),
  supersedes_revision_id uuid REFERENCES routing_recovery_minute_revisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_definition_id,bucket_start,target_capture_profile_revision_id,revision_number),
  CHECK (bucket_end = bucket_start + interval '1 minute'),
  CHECK (projected_rrc_count <= expected_rrc_count)
);

CREATE TABLE routing_recovery_minute_heads (
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  bucket_start timestamptz NOT NULL,
  target_capture_profile_revision_id uuid NOT NULL REFERENCES stream_capture_profile_revisions(id) ON DELETE CASCADE,
  current_revision_id uuid NOT NULL REFERENCES routing_recovery_minute_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(source_definition_id,bucket_start,target_capture_profile_revision_id)
);

ALTER TABLE routing_minute_bucket_revisions
  ADD COLUMN live_collection_coverage_status text
    CHECK (live_collection_coverage_status IS NULL OR live_collection_coverage_status IN ('COMPLETE','PARTIAL','DEGRADED','NO_COVERAGE'));
UPDATE routing_minute_bucket_revisions
SET live_collection_coverage_status=coverage_status
WHERE acquisition_basis='LIVE_STREAM' AND live_collection_coverage_status IS NULL;

CREATE OR REPLACE FUNCTION reject_node6_2_immutable_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'NODE-6.2 provenance/recovery revisions are immutable; append a new revision instead'; END; $$;
CREATE TRIGGER stream_recovery_policy_revisions_immutable_update BEFORE UPDATE ON stream_recovery_policy_revisions FOR EACH ROW EXECUTE FUNCTION reject_node6_2_immutable_update();
CREATE TRIGGER stream_recovery_attempt_events_immutable_update BEFORE UPDATE ON stream_recovery_attempt_events FOR EACH ROW EXECUTE FUNCTION reject_node6_2_immutable_update();
CREATE TRIGGER routing_recovery_minute_deltas_immutable_update BEFORE UPDATE ON routing_recovery_minute_deltas FOR EACH ROW EXECUTE FUNCTION reject_node6_2_immutable_update();
CREATE TRIGGER routing_recovery_minute_revisions_immutable_update BEFORE UPDATE ON routing_recovery_minute_revisions FOR EACH ROW EXECUTE FUNCTION reject_node6_2_immutable_update();

COMMIT;

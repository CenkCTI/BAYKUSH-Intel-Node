BEGIN;

CREATE TABLE source_schedule_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  effective_from timestamptz NOT NULL,
  enabled boolean NOT NULL,
  collection_mode text NOT NULL CHECK (collection_mode IN ('POLL','PAGED_POLL','SNAPSHOT','STREAM')),
  poll_interval_seconds integer CHECK (poll_interval_seconds IS NULL OR poll_interval_seconds > 0),
  cadence_anchor_at timestamptz,
  coverage_grace_seconds integer NOT NULL CHECK (coverage_grace_seconds BETWEEN 1 AND 3600),
  adapter_version text NOT NULL,
  semantic_contract_version text NOT NULL,
  origin_status text NOT NULL CHECK (origin_status IN ('AUTHORITATIVE_NODE3','NODE3_BASELINE','RECONSTRUCTED','UNKNOWN')),
  change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX source_schedule_revisions_lookup_idx
  ON source_schedule_revisions(source_definition_id, effective_from DESC);

CREATE TABLE coverage_reconciliation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_run_id uuid NOT NULL UNIQUE REFERENCES collection_runs(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX coverage_reconciliation_jobs_claim_idx
  ON coverage_reconciliation_jobs(state, available_at, lease_expires_at, created_at);

CREATE TABLE source_acquisition_windows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  collection_run_id uuid NOT NULL REFERENCES collection_runs(id) ON DELETE CASCADE,
  window_key text NOT NULL,
  projection_version text NOT NULL,
  window_kind text NOT NULL CHECK (window_kind IN ('INTERVAL','SNAPSHOT','DATASET_DATE')),
  time_axis text NOT NULL CHECK (time_axis IN (
    'SOURCE_EFFECTIVE_TIME','SOURCE_PUBLISHED_TIME','UPSTREAM_UPDATED_TIME','NODE_RECEIVED_TIME','SOURCE_DATASET_DATE'
  )),
  window_start timestamptz,
  window_end timestamptz,
  dataset_date date,
  availability_status text NOT NULL CHECK (availability_status IN ('AVAILABLE','PARTIAL','UNAVAILABLE','UNKNOWN')),
  acquisition_basis text NOT NULL CHECK (acquisition_basis IN (
    'LIVE_INCREMENTAL','INITIAL_BOOTSTRAP','RECOVERY','HISTORICAL_BACKFILL','RESYNC','REPAIR','SNAPSHOT_RECONSTRUCTION'
  )),
  recovery_status text NOT NULL CHECK (recovery_status IN ('NOT_APPLICABLE','COMPLETE','PARTIAL','IN_PROGRESS','UNRECOVERABLE','UNKNOWN')),
  recovery_gap_exceeded boolean NOT NULL DEFAULT false,
  population_profile jsonb,
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_definition_id, collection_run_id, window_key, projection_version),
  CHECK (
    (window_kind = 'INTERVAL' AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_end > window_start AND dataset_date IS NULL)
    OR (window_kind = 'DATASET_DATE' AND dataset_date IS NOT NULL AND window_start IS NULL AND window_end IS NULL)
    OR (window_kind = 'SNAPSHOT' AND dataset_date IS NULL)
  )
);

CREATE INDEX source_acquisition_windows_interval_idx
  ON source_acquisition_windows(source_definition_id, time_axis, window_start, window_end)
  WHERE window_kind = 'INTERVAL';
CREATE INDEX source_acquisition_windows_dataset_idx
  ON source_acquisition_windows(source_definition_id, time_axis, dataset_date)
  WHERE window_kind = 'DATASET_DATE';

CREATE TABLE source_coverage_bucket_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  granularity text NOT NULL CHECK (granularity IN ('FIVE_MINUTES','HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  expectation_status text NOT NULL CHECK (expectation_status IN ('EXPECTED','NOT_EXPECTED','UNKNOWN')),
  coverage_status text NOT NULL CHECK (coverage_status IN ('COMPLETE','PARTIAL','DEGRADED','NO_COVERAGE')),
  evaluation_state text NOT NULL CHECK (evaluation_state IN ('PROVISIONAL','FINAL','REVISED')),
  expected_opportunity_count integer NOT NULL CHECK (expected_opportunity_count >= 0),
  satisfied_opportunity_count integer NOT NULL CHECK (satisfied_opportunity_count >= 0),
  partial_opportunity_count integer NOT NULL CHECK (partial_opportunity_count >= 0),
  failed_opportunity_count integer NOT NULL CHECK (failed_opportunity_count >= 0),
  missing_opportunity_count integer NOT NULL CHECK (missing_opportunity_count >= 0),
  schedule_origin text NOT NULL CHECK (schedule_origin IN ('AUTHORITATIVE_NODE3','NODE3_BASELINE','RECONSTRUCTED','UNKNOWN')),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  supersedes_revision_id uuid REFERENCES source_coverage_bucket_revisions(id) ON DELETE RESTRICT,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (bucket_end > bucket_start),
  CHECK (satisfied_opportunity_count + partial_opportunity_count + failed_opportunity_count + missing_opportunity_count <= expected_opportunity_count),
  UNIQUE (source_definition_id, granularity, bucket_start, revision_number)
);

CREATE INDEX source_coverage_bucket_revisions_lookup_idx
  ON source_coverage_bucket_revisions(source_definition_id, granularity, bucket_start, revision_number DESC);

CREATE TABLE source_coverage_bucket_heads (
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  granularity text NOT NULL CHECK (granularity IN ('FIVE_MINUTES','HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  current_revision_id uuid NOT NULL REFERENCES source_coverage_bucket_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_definition_id, granularity, bucket_start),
  CHECK (bucket_end > bucket_start)
);

CREATE TABLE source_coverage_dirty_buckets (
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  granularity text NOT NULL CHECK (granularity IN ('FIVE_MINUTES','HOUR','DAY')),
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  dirty_revision bigint NOT NULL DEFAULT 1 CHECK (dirty_revision > 0),
  dirty_since timestamptz NOT NULL DEFAULT now(),
  dirty_reasons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(dirty_reasons) = 'array'),
  lease_owner text,
  lease_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_definition_id, granularity, bucket_start),
  CHECK (bucket_end > bucket_start)
);

CREATE INDEX source_coverage_dirty_claim_idx
  ON source_coverage_dirty_buckets(lease_expires_at, dirty_since);

CREATE TABLE source_coverage_reconciliation_state (
  source_definition_id uuid PRIMARY KEY REFERENCES source_definitions(id) ON DELETE CASCADE,
  evaluated_through timestamptz,
  last_collection_run_created_at timestamptz,
  last_schedule_revision_id uuid REFERENCES source_schedule_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_node3_history_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-3 historical revisions are immutable; append a new revision instead';
END;
$$;

CREATE TRIGGER source_schedule_revisions_immutable_update
BEFORE UPDATE ON source_schedule_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node3_history_update();

CREATE TRIGGER source_acquisition_windows_immutable_update
BEFORE UPDATE ON source_acquisition_windows
FOR EACH ROW EXECUTE FUNCTION reject_node3_history_update();

CREATE TRIGGER source_coverage_bucket_revisions_immutable_update
BEFORE UPDATE ON source_coverage_bucket_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node3_history_update();

INSERT INTO source_schedule_revisions(
  source_definition_id, effective_from, enabled, collection_mode,
  poll_interval_seconds, cadence_anchor_at, coverage_grace_seconds,
  adapter_version, semantic_contract_version, origin_status, change_reason
)
SELECT d.id, now(), d.enabled, d.collection_mode, d.default_poll_interval_seconds,
       s.next_due_at,
       LEAST(GREATEST(COALESCE(d.default_poll_interval_seconds / 4, 60), 60), 900),
       d.adapter_version, d.semantic_contract_version,
       'NODE3_BASELINE', 'NODE-3 measurement/coverage baseline'
FROM source_definitions d
LEFT JOIN source_schedule_state s ON s.source_definition_id = d.id;

INSERT INTO source_coverage_reconciliation_state(source_definition_id, last_schedule_revision_id)
SELECT d.id, latest.id
FROM source_definitions d
JOIN LATERAL (
  SELECT r.id
  FROM source_schedule_revisions r
  WHERE r.source_definition_id = d.id
  ORDER BY r.effective_from DESC, r.created_at DESC
  LIMIT 1
) latest ON true
ON CONFLICT (source_definition_id) DO NOTHING;

CREATE OR REPLACE FUNCTION record_source_schedule_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  anchor timestamptz;
  grace integer;
  reason text;
BEGIN
  IF NOT (
    OLD.enabled IS DISTINCT FROM NEW.enabled
    OR OLD.collection_mode IS DISTINCT FROM NEW.collection_mode
    OR OLD.default_poll_interval_seconds IS DISTINCT FROM NEW.default_poll_interval_seconds
    OR OLD.adapter_version IS DISTINCT FROM NEW.adapter_version
    OR OLD.semantic_contract_version IS DISTINCT FROM NEW.semantic_contract_version
  ) THEN
    RETURN NEW;
  END IF;

  SELECT next_due_at INTO anchor
  FROM source_schedule_state
  WHERE source_definition_id = NEW.id;

  IF OLD.enabled = false AND NEW.enabled = true THEN
    anchor := now();
    reason := 'SOURCE_ENABLED';
  ELSIF OLD.enabled = true AND NEW.enabled = false THEN
    reason := 'SOURCE_DISABLED';
  ELSIF OLD.default_poll_interval_seconds IS DISTINCT FROM NEW.default_poll_interval_seconds THEN
    anchor := now();
    reason := 'POLL_INTERVAL_CHANGED';
  ELSIF OLD.collection_mode IS DISTINCT FROM NEW.collection_mode THEN
    anchor := now();
    reason := 'COLLECTION_MODE_CHANGED';
  ELSE
    reason := 'SOURCE_CONTRACT_CHANGED';
  END IF;

  grace := LEAST(GREATEST(COALESCE(NEW.default_poll_interval_seconds / 4, 60), 60), 900);

  INSERT INTO source_schedule_revisions(
    source_definition_id, effective_from, enabled, collection_mode,
    poll_interval_seconds, cadence_anchor_at, coverage_grace_seconds,
    adapter_version, semantic_contract_version, origin_status, change_reason
  ) VALUES (
    NEW.id, now(), NEW.enabled, NEW.collection_mode,
    NEW.default_poll_interval_seconds, anchor, grace,
    NEW.adapter_version, NEW.semantic_contract_version,
    'AUTHORITATIVE_NODE3', reason
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER source_definitions_schedule_history
AFTER UPDATE ON source_definitions
FOR EACH ROW EXECUTE FUNCTION record_source_schedule_revision();

COMMIT;

BEGIN;

ALTER TABLE runtime_heartbeats
  DROP CONSTRAINT runtime_heartbeats_component_check;

ALTER TABLE runtime_heartbeats
  ADD CONSTRAINT runtime_heartbeats_component_check
  CHECK (component IN ('API','SCHEDULER','WORKER','NORMALIZER','MEASUREMENT','BACKFILL'));

CREATE TABLE historical_backfill_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES historical_backfill_requests(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  segment_kind text NOT NULL CHECK (segment_kind IN ('INTERVAL','DATASET_DATE')),
  window_start timestamptz,
  window_end timestamptz,
  dataset_date date,
  state text NOT NULL DEFAULT 'QUEUED' CHECK (state IN (
    'QUEUED','RUNNING','SUCCEEDED','FAILED_RETRYABLE','FAILED_TERMINAL','CANCELLED'
  )),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  records_accepted bigint NOT NULL DEFAULT 0 CHECK (records_accepted >= 0),
  records_inserted bigint NOT NULL DEFAULT 0 CHECK (records_inserted >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (request_id, segment_index),
  CHECK (
    (segment_kind = 'INTERVAL' AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_end > window_start AND dataset_date IS NULL)
    OR
    (segment_kind = 'DATASET_DATE' AND dataset_date IS NOT NULL AND window_start IS NULL AND window_end IS NULL)
  )
);

CREATE INDEX historical_backfill_segments_claim_idx
  ON historical_backfill_segments(state, available_at, lease_expires_at, created_at);

CREATE INDEX historical_backfill_segments_source_state_idx
  ON historical_backfill_segments(source_definition_id, state, segment_index);

ALTER TABLE collection_runs
  ADD COLUMN historical_backfill_segment_id uuid UNIQUE
  REFERENCES historical_backfill_segments(id) ON DELETE RESTRICT;

ALTER TABLE collection_runs
  ADD CONSTRAINT collection_runs_historical_segment_purpose_check
  CHECK (historical_backfill_segment_id IS NULL OR purpose = 'HISTORICAL_BACKFILL');

COMMIT;

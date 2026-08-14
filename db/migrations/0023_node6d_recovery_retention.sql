BEGIN;

CREATE TABLE stream_recovery_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recovery_request_id uuid NOT NULL REFERENCES stream_recovery_requests(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  segment_index integer NOT NULL CHECK (segment_index >= 0),
  rrc text NOT NULL CHECK (rrc ~ '^rrc[0-9]{2}$'),
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  source_url text NOT NULL CHECK (source_url ~ '^https://data[.]ris[.]ripe[.]net/rrc[0-9]{2}/[0-9]{4}[.][0-9]{2}/update[.][0-9]{8}[.][0-9]{4}[.]gz$'),
  state text NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','DOWNLOADED','PROJECTED','FAILED','CANCELLED')),
  artifact_sha256 char(64) CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes bigint CHECK (artifact_bytes IS NULL OR artifact_bytes >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  downloaded_at timestamptz,
  projected_at timestamptz,
  UNIQUE(recovery_request_id, segment_index),
  UNIQUE(recovery_request_id, rrc, window_start),
  CHECK (window_end = window_start + interval '5 minutes')
);
CREATE INDEX stream_recovery_segments_state_idx ON stream_recovery_segments(state,window_start);

CREATE TABLE stream_retention_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  payloads_deleted bigint NOT NULL DEFAULT 0 CHECK (payloads_deleted >= 0),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  failure_message text
);

COMMIT;

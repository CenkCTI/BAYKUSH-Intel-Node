BEGIN;

CREATE TABLE stream_segment_manifests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  capture_profile_revision_id uuid REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  stream_session_id uuid NOT NULL REFERENCES stream_sessions(id) ON DELETE CASCADE,
  segment_sequence bigint NOT NULL CHECK (segment_sequence >= 0),
  source_time_min timestamptz,
  source_time_max timestamptz,
  node_received_min timestamptz NOT NULL,
  node_received_max timestamptz NOT NULL,
  message_count integer NOT NULL CHECK (message_count > 0),
  update_message_count integer NOT NULL DEFAULT 0 CHECK (update_message_count >= 0),
  peer_state_message_count integer NOT NULL DEFAULT 0 CHECK (peer_state_message_count >= 0),
  rejected_message_count integer NOT NULL DEFAULT 0 CHECK (rejected_message_count >= 0),
  uncompressed_bytes bigint NOT NULL CHECK (uncompressed_bytes > 0),
  compressed_bytes bigint NOT NULL CHECK (compressed_bytes > 0),
  content_sha256 char(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  first_message_id text,
  last_message_id text,
  acquisition_channel text NOT NULL CHECK (acquisition_channel IN ('RIS_LIVE_WEBSOCKET','RIS_MRT_UPDATE','RIS_MRT_RIB')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(stream_session_id, segment_sequence),
  UNIQUE(source_definition_id, acquisition_channel, content_sha256),
  CHECK (node_received_max >= node_received_min),
  CHECK (source_time_max IS NULL OR source_time_min IS NULL OR source_time_max >= source_time_min)
);
CREATE INDEX stream_segment_manifests_source_time_idx ON stream_segment_manifests(source_definition_id,source_time_min,source_time_max);

CREATE TABLE stream_segment_payloads (
  segment_id uuid PRIMARY KEY REFERENCES stream_segment_manifests(id) ON DELETE CASCADE,
  payload_compressed bytea NOT NULL,
  compression text NOT NULL CHECK (compression IN ('GZIP')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
) PARTITION BY RANGE (expires_at);
CREATE TABLE stream_segment_payloads_default PARTITION OF stream_segment_payloads DEFAULT;
CREATE INDEX stream_segment_payloads_default_expires_idx ON stream_segment_payloads_default(expires_at);

CREATE TABLE routing_segment_deltas (
  segment_id uuid PRIMARY KEY REFERENCES stream_segment_manifests(id) ON DELETE CASCADE,
  calculation_version text NOT NULL,
  update_message_count integer NOT NULL CHECK (update_message_count >= 0),
  announcement_prefix_event_count bigint NOT NULL CHECK (announcement_prefix_event_count >= 0),
  withdrawal_prefix_event_count bigint NOT NULL CHECK (withdrawal_prefix_event_count >= 0),
  announced_prefixes jsonb NOT NULL CHECK (jsonb_typeof(announced_prefixes)='array'),
  withdrawn_prefixes jsonb NOT NULL CHECK (jsonb_typeof(withdrawn_prefixes)='array'),
  all_prefixes jsonb NOT NULL CHECK (jsonb_typeof(all_prefixes)='array'),
  origin_asns jsonb NOT NULL CHECK (jsonb_typeof(origin_asns)='array'),
  peer_asns jsonb NOT NULL CHECK (jsonb_typeof(peer_asns)='array'),
  rrcs jsonb NOT NULL CHECK (jsonb_typeof(rrcs)='array'),
  ipv4_prefix_event_count bigint NOT NULL DEFAULT 0 CHECK (ipv4_prefix_event_count >= 0),
  ipv6_prefix_event_count bigint NOT NULL DEFAULT 0 CHECK (ipv6_prefix_event_count >= 0),
  rejected_message_count integer NOT NULL DEFAULT 0 CHECK (rejected_message_count >= 0),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;

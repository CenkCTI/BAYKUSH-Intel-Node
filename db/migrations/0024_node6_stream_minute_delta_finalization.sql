BEGIN;

CREATE TABLE routing_segment_minute_deltas (
  segment_id uuid NOT NULL REFERENCES stream_segment_manifests(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  capture_profile_revision_id uuid REFERENCES stream_capture_profile_revisions(id) ON DELETE RESTRICT,
  bucket_start timestamptz NOT NULL,
  bucket_end timestamptz NOT NULL,
  update_message_count bigint NOT NULL CHECK (update_message_count >= 0),
  announcement_prefix_event_count bigint NOT NULL CHECK (announcement_prefix_event_count >= 0),
  withdrawal_prefix_event_count bigint NOT NULL CHECK (withdrawal_prefix_event_count >= 0),
  announced_prefixes jsonb NOT NULL CHECK (jsonb_typeof(announced_prefixes) = 'array'),
  withdrawn_prefixes jsonb NOT NULL CHECK (jsonb_typeof(withdrawn_prefixes) = 'array'),
  all_prefixes jsonb NOT NULL CHECK (jsonb_typeof(all_prefixes) = 'array'),
  origin_asns jsonb NOT NULL CHECK (jsonb_typeof(origin_asns) = 'array'),
  peer_asns jsonb NOT NULL CHECK (jsonb_typeof(peer_asns) = 'array'),
  rrcs jsonb NOT NULL CHECK (jsonb_typeof(rrcs) = 'array'),
  ipv4_prefix_event_count bigint NOT NULL DEFAULT 0 CHECK (ipv4_prefix_event_count >= 0),
  ipv6_prefix_event_count bigint NOT NULL DEFAULT 0 CHECK (ipv6_prefix_event_count >= 0),
  rejected_message_count integer NOT NULL DEFAULT 0 CHECK (rejected_message_count >= 0),
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, bucket_start),
  CHECK (bucket_end = bucket_start + interval '1 minute')
);

CREATE INDEX routing_segment_minute_deltas_source_bucket_idx
  ON routing_segment_minute_deltas(source_definition_id, bucket_start, segment_id);

CREATE TRIGGER routing_segment_minute_deltas_immutable_update
BEFORE UPDATE ON routing_segment_minute_deltas
FOR EACH ROW EXECUTE FUNCTION reject_node6_stream_contract_update();

COMMIT;

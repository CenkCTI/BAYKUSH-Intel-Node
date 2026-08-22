BEGIN;

-- Expand the durable heartbeat vocabulary to every long-lived runtime plane.
ALTER TABLE runtime_heartbeats
  DROP CONSTRAINT IF EXISTS runtime_heartbeats_component_check;
ALTER TABLE runtime_heartbeats
  ADD CONSTRAINT runtime_heartbeats_component_check CHECK (component IN (
    'API','SCHEDULER','WORKER','NORMALIZER','MEASUREMENT','BACKFILL',
    'STREAM_WORKER','RECOVERY_WORKER','DISCOVERY_WORKER'
  ));

CREATE INDEX IF NOT EXISTS runtime_heartbeats_at_idx
  ON runtime_heartbeats(heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS source_health_updated_idx
  ON source_health(updated_at DESC);

CREATE OR REPLACE VIEW node_runtime_component_health AS
SELECT
  component,
  instance_id,
  heartbeat_at,
  GREATEST(0, EXTRACT(EPOCH FROM (now() - heartbeat_at)))::bigint AS heartbeat_age_seconds,
  (heartbeat_at >= now() - interval '60 seconds') AS fresh,
  metadata
FROM runtime_heartbeats;

-- 0039 intentionally avoids default privileges, so every new operational object
-- must receive an explicit grant. API remains SELECT-only.
GRANT SELECT ON node_runtime_component_health
  TO baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;
GRANT SELECT ON runtime_heartbeats, source_health, source_definitions
  TO baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Discovery runs under the projection capability and now emits a normal worker
-- heartbeat. Existing role migration already grants projection writes on
-- runtime_heartbeats; repeat explicitly for populated upgrades/review clarity.
GRANT INSERT, UPDATE ON runtime_heartbeats TO baykush_projection;

COMMIT;

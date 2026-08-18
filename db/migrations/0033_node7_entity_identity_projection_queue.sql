BEGIN;

ALTER TABLE runtime_heartbeats DROP CONSTRAINT runtime_heartbeats_component_check;
ALTER TABLE runtime_heartbeats ADD CONSTRAINT runtime_heartbeats_component_check
  CHECK (component IN (
    'API','SCHEDULER','WORKER','NORMALIZER','MEASUREMENT','BACKFILL',
    'STREAM_WORKER','RECOVERY_WORKER','NODE7_WORKER'
  ));

CREATE TABLE technical_entity_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  entity_key text NOT NULL CHECK (length(entity_key) > 0),
  identity_sha256 char(64) GENERATED ALWAYS AS (
    encode(digest(entity_type || chr(0) || entity_key, 'sha256'), 'hex')::char(64)
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(entity_type, entity_key),
  UNIQUE(identity_sha256)
);

CREATE OR REPLACE FUNCTION reject_node7_entity_registry_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 technical entity registry rows are immutable';
END;
$$;

CREATE TRIGGER technical_entity_registry_immutable_update
BEFORE UPDATE ON technical_entity_registry
FOR EACH ROW EXECUTE FUNCTION reject_node7_entity_registry_mutation();

CREATE TRIGGER technical_entity_registry_immutable_delete
BEFORE DELETE ON technical_entity_registry
FOR EACH ROW EXECUTE FUNCTION reject_node7_entity_registry_mutation();

CREATE TABLE node7_projection_checkpoints (
  projection_key text PRIMARY KEY CHECK (projection_key IN ('ENTITY_OBSERVATION_CURSOR')),
  last_revision_created_at timestamptz,
  last_revision_id uuid REFERENCES entity_observation_revisions(id) ON DELETE RESTRICT,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(last_revision_created_at, last_revision_id) IN (0, 2))
);

CREATE TABLE node7_dirty_entities (
  entity_id uuid PRIMARY KEY REFERENCES technical_entity_registry(id) ON DELETE CASCADE,
  dirty_since timestamptz NOT NULL DEFAULT now(),
  dirty_revision bigint NOT NULL DEFAULT 1 CHECK (dirty_revision > 0),
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reason_codes) = 'array'),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_failure_code text,
  last_failure_message text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((lease_owner IS NULL AND lease_expires_at IS NULL) OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX node7_dirty_entities_claim_idx
  ON node7_dirty_entities(available_at, lease_expires_at, dirty_since);

INSERT INTO technical_entity_registry(entity_type, entity_key)
SELECT DISTINCT entity_type, entity_key
FROM entity_observation_revisions
ON CONFLICT (entity_type, entity_key) DO NOTHING;

INSERT INTO node7_projection_checkpoints(projection_key)
VALUES ('ENTITY_OBSERVATION_CURSOR')
ON CONFLICT (projection_key) DO NOTHING;

UPDATE node7_projection_checkpoints checkpoint
SET last_revision_created_at = latest.created_at,
    last_revision_id = latest.id,
    revision = checkpoint.revision + 1,
    updated_at = now()
FROM (
  SELECT id, created_at
  FROM entity_observation_revisions
  ORDER BY created_at DESC, id DESC
  LIMIT 1
) latest
WHERE checkpoint.projection_key = 'ENTITY_OBSERVATION_CURSOR';

INSERT INTO node7_dirty_entities(entity_id, reason_codes)
SELECT id, '["HISTORICAL_BOOTSTRAP"]'::jsonb
FROM technical_entity_registry
ON CONFLICT (entity_id) DO NOTHING;

COMMIT;

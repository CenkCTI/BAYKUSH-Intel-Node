BEGIN;

ALTER TABLE runtime_heartbeats
  DROP CONSTRAINT runtime_heartbeats_component_check;

ALTER TABLE runtime_heartbeats
  ADD CONSTRAINT runtime_heartbeats_component_check
  CHECK (component IN ('API','SCHEDULER','WORKER','NORMALIZER','MEASUREMENT'));

CREATE TABLE historical_backfill_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  requested_from timestamptz NOT NULL,
  requested_to timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN (
    'PLANNED','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNSUPPORTED'
  )),
  backfill_policy_version text NOT NULL,
  segment_cursor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(segment_cursor) = 'object'),
  checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  segments_planned integer NOT NULL DEFAULT 0 CHECK (segments_planned >= 0),
  segments_completed integer NOT NULL DEFAULT 0 CHECK (segments_completed >= 0),
  records_inserted bigint NOT NULL DEFAULT 0 CHECK (records_inserted >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_to > requested_from),
  CHECK (segments_completed <= segments_planned)
);

CREATE INDEX historical_backfill_requests_source_status_idx
  ON historical_backfill_requests(source_definition_id, status, created_at DESC);

ALTER TABLE measurement_fact_inputs
  ADD COLUMN entity_history_revision_id uuid
  REFERENCES entity_history_revisions(id) ON DELETE RESTRICT;

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname
  INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid = rel.relnamespace
  WHERE ns.nspname = current_schema()
    AND rel.relname = 'measurement_fact_inputs'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) LIKE '%num_nonnulls(raw_record_id, canonical_record_id, collection_run_id)%'
  ORDER BY con.conname
  LIMIT 1;

  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'NODE-3 expected the original measurement_fact_inputs exactly-one CHECK constraint';
  END IF;

  EXECUTE format('ALTER TABLE measurement_fact_inputs DROP CONSTRAINT %I', constraint_name);
END;
$$;

ALTER TABLE measurement_fact_inputs
  ADD CONSTRAINT measurement_fact_inputs_exactly_one_check
  CHECK (
    num_nonnulls(
      raw_record_id,
      canonical_record_id,
      collection_run_id,
      entity_history_revision_id
    ) = 1
  );

CREATE UNIQUE INDEX measurement_fact_inputs_entity_history_unique
  ON measurement_fact_inputs(measurement_fact_id, input_role, entity_history_revision_id)
  WHERE entity_history_revision_id IS NOT NULL;

CREATE INDEX measurement_fact_inputs_entity_history_idx
  ON measurement_fact_inputs(entity_history_revision_id)
  WHERE entity_history_revision_id IS NOT NULL;

COMMIT;

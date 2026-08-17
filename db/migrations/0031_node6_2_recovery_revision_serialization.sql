BEGIN;

CREATE OR REPLACE FUNCTION serialize_node6_2_mrt_revision_number() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  next_revision integer;
  lock_key bigint;
BEGIN
  IF NEW.acquisition_basis <> 'MRT_RECOVERY' THEN RETURN NEW; END IF;

  lock_key := hashtextextended(
    NEW.source_definition_id::text || '|' || NEW.bucket_start::text,
    0
  );
  PERFORM pg_advisory_xact_lock(lock_key);

  SELECT COALESCE(max(revision_number),0)+1
  INTO next_revision
  FROM routing_minute_bucket_revisions
  WHERE source_definition_id=NEW.source_definition_id
    AND bucket_start=NEW.bucket_start;

  NEW.revision_number := next_revision;
  RETURN NEW;
END; $$;

CREATE TRIGGER routing_mrt_recovery_revision_serialization
BEFORE INSERT ON routing_minute_bucket_revisions
FOR EACH ROW EXECUTE FUNCTION serialize_node6_2_mrt_revision_number();

COMMIT;

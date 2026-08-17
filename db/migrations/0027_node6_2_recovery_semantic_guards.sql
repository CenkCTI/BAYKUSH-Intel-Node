BEGIN;

DO $$
DECLARE
  old_constraint text;
BEGIN
  SELECT constraint_row.conname
  INTO old_constraint
  FROM pg_constraint constraint_row
  JOIN pg_class relation_row ON relation_row.oid=constraint_row.conrelid
  WHERE relation_row.relname='routing_recovery_minute_deltas'
    AND constraint_row.contype='u'
    AND (
      SELECT array_agg(attribute_row.attname ORDER BY key_row.ordinality)
      FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key_row(attnum,ordinality)
      JOIN pg_attribute attribute_row
        ON attribute_row.attrelid=constraint_row.conrelid
       AND attribute_row.attnum=key_row.attnum
    )=ARRAY['recovery_segment_id','bucket_start']::text[]
  LIMIT 1;

  IF old_constraint IS NULL THEN
    RAISE EXCEPTION 'Expected NODE-6.2 segment/bucket unique constraint was not found';
  END IF;

  EXECUTE format(
    'ALTER TABLE routing_recovery_minute_deltas DROP CONSTRAINT %I',
    old_constraint
  );
END; $$;

ALTER TABLE routing_recovery_minute_deltas
  ADD CONSTRAINT routing_recovery_deltas_segment_artifact_bucket_uq
  UNIQUE(recovery_segment_id,artifact_id,bucket_start);

ALTER TABLE stream_recovery_requests
  ADD COLUMN trigger_event_id uuid REFERENCES stream_session_events(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX stream_recovery_requests_trigger_event_uq
  ON stream_recovery_requests(trigger_event_id)
  WHERE trigger_event_id IS NOT NULL AND automatic;

CREATE OR REPLACE FUNCTION guard_node6_2_recovered_routing_head() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  old_basis text;
  new_basis text;
  new_coverage text;
BEGIN
  IF NEW.current_revision_id = OLD.current_revision_id THEN RETURN NEW; END IF;
  SELECT acquisition_basis INTO old_basis FROM routing_minute_bucket_revisions WHERE id=OLD.current_revision_id;
  SELECT acquisition_basis,coverage_status INTO new_basis,new_coverage FROM routing_minute_bucket_revisions WHERE id=NEW.current_revision_id;
  IF old_basis='MRT_RECOVERY' AND new_basis='LIVE_STREAM' AND new_coverage<>'COMPLETE' THEN
    NEW.current_revision_id := OLD.current_revision_id;
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER routing_minute_heads_recovery_guard
BEFORE UPDATE OF current_revision_id ON routing_minute_bucket_heads
FOR EACH ROW EXECUTE FUNCTION guard_node6_2_recovered_routing_head();

CREATE OR REPLACE FUNCTION node6_2_routing_measurement_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  measurement_key_value text;
  routing_source_id uuid;
  bases text[];
  live_statuses text[];
  basis_summary text;
  minute_count integer;
BEGIN
  SELECT measurement_key INTO measurement_key_value
  FROM measurement_definitions WHERE id=NEW.measurement_definition_id;
  IF measurement_key_value IS NULL OR measurement_key_value NOT LIKE 'routing.ripe_ris.%' THEN RETURN NEW; END IF;

  SELECT id INTO routing_source_id FROM source_definitions WHERE source_key='RIPE_RIS_BGP';
  IF routing_source_id IS NULL THEN RETURN NEW; END IF;

  SELECT
    array_agg(DISTINCT r.acquisition_basis ORDER BY r.acquisition_basis),
    array_agg(DISTINCT COALESCE(r.live_collection_coverage_status,CASE WHEN r.acquisition_basis='LIVE_STREAM' THEN r.coverage_status ELSE NULL END)
              ORDER BY COALESCE(r.live_collection_coverage_status,CASE WHEN r.acquisition_basis='LIVE_STREAM' THEN r.coverage_status ELSE NULL END))
      FILTER (WHERE COALESCE(r.live_collection_coverage_status,CASE WHEN r.acquisition_basis='LIVE_STREAM' THEN r.coverage_status ELSE NULL END) IS NOT NULL),
    count(*)::integer
  INTO bases,live_statuses,minute_count
  FROM routing_minute_bucket_heads h
  JOIN routing_minute_bucket_revisions r ON r.id=h.current_revision_id
  WHERE h.source_definition_id=routing_source_id
    AND h.bucket_start>=NEW.bucket_start AND h.bucket_start<NEW.bucket_end;

  IF bases IS NULL OR cardinality(bases)=0 THEN RETURN NEW; END IF;
  basis_summary := CASE
    WHEN cardinality(bases)=1 AND bases[1]='LIVE_STREAM' THEN 'LIVE_STREAM'
    WHEN cardinality(bases)=1 AND bases[1]='MRT_RECOVERY' THEN 'MRT_RECOVERY'
    ELSE 'MIXED'
  END;

  NEW.acquisition_summary := jsonb_build_array(jsonb_build_object(
    'upstreamOrigin','RIPE_RIS',
    'basis',basis_summary,
    'channels',to_jsonb(bases),
    'minuteRows',minute_count
  ));
  NEW.comparison_context := COALESCE(NEW.comparison_context,'{}'::jsonb) || jsonb_build_object(
    'routingAcquisitionBasis',basis_summary,
    'routingAcquisitionChannels',to_jsonb(bases),
    'liveCollectionCoverageStatuses',COALESCE(to_jsonb(live_statuses),'[]'::jsonb)
  );
  RETURN NEW;
END; $$;

CREATE TRIGGER measurement_bucket_routing_provenance
BEFORE INSERT OR UPDATE ON measurement_bucket_revisions
FOR EACH ROW EXECUTE FUNCTION node6_2_routing_measurement_provenance();

COMMIT;

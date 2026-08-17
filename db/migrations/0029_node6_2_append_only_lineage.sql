BEGIN;

CREATE OR REPLACE FUNCTION reject_node6_2_lineage_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-6.2 recovery lineage is append-only; delete is forbidden';
END; $$;

CREATE TRIGGER stream_recovery_policy_revisions_no_delete
BEFORE DELETE ON stream_recovery_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER stream_recovery_requests_no_delete
BEFORE DELETE ON stream_recovery_requests
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER stream_recovery_segments_no_delete
BEFORE DELETE ON stream_recovery_segments
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER stream_recovery_artifacts_no_delete
BEFORE DELETE ON stream_recovery_artifacts
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER stream_recovery_decoder_runs_no_delete
BEFORE DELETE ON stream_recovery_decoder_runs
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER stream_recovery_attempt_events_no_delete
BEFORE DELETE ON stream_recovery_attempt_events
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER routing_recovery_minute_deltas_no_delete
BEFORE DELETE ON routing_recovery_minute_deltas
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

CREATE TRIGGER routing_recovery_minute_revisions_no_delete
BEFORE DELETE ON routing_recovery_minute_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node6_2_lineage_delete();

COMMIT;

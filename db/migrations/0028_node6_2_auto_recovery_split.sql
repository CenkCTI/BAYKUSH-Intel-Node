BEGIN;

DROP INDEX stream_recovery_requests_trigger_event_uq;
CREATE UNIQUE INDEX stream_recovery_requests_trigger_event_profile_uq
  ON stream_recovery_requests(trigger_event_id,target_capture_profile_revision_id)
  WHERE trigger_event_id IS NOT NULL AND automatic;

COMMIT;

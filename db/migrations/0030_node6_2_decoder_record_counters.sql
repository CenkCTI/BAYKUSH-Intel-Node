BEGIN;

ALTER TABLE stream_recovery_decoder_runs
  ADD COLUMN state_change_records bigint NOT NULL DEFAULT 0 CHECK (state_change_records >= 0);

ALTER TABLE stream_recovery_decoder_runs
  ADD CONSTRAINT stream_recovery_decoder_run_counter_consistency
  CHECK (
    updates_decoded + records_ignored <= records_read
    AND state_change_records <= records_ignored
    AND records_rejected <= records_read
  );

COMMIT;

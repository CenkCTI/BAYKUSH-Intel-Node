BEGIN;

ALTER TABLE stream_recovery_segments
  DROP CONSTRAINT stream_recovery_segments_source_url_check;
ALTER TABLE stream_recovery_segments
  ADD CONSTRAINT stream_recovery_segments_source_url_check
  CHECK (source_url ~ '^https://data[.]ris[.]ripe[.]net/rrc[0-9]{2}/[0-9]{4}[.][0-9]{2}/updates[.][0-9]{8}[.][0-9]{4}[.]gz$');

ALTER TABLE stream_recovery_artifacts
  DROP CONSTRAINT stream_recovery_artifacts_source_url_check;
ALTER TABLE stream_recovery_artifacts
  ADD CONSTRAINT stream_recovery_artifacts_source_url_check
  CHECK (source_url ~ '^https://data[.]ris[.]ripe[.]net/rrc[0-9]{2}/[0-9]{4}[.][0-9]{2}/updates[.][0-9]{8}[.][0-9]{4}[.]gz$');

COMMIT;

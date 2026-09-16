BEGIN;

-- NODE-8C separates stable database capabilities from rotating login credentials.
-- These NOLOGIN roles are schema capabilities only. Production login roles are
-- provisioned by deploy/production/scripts/provision-db-roles.sh and inherit
-- exactly one capability role. Passwords never enter migrations or Git.
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'baykush_api',
    'baykush_ingest',
    'baykush_projection',
    'baykush_stream',
    'baykush_recovery'
  ] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT',
        role_name
      );
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  capability text;
  inherited text;
BEGIN
  FOREACH capability IN ARRAY ARRAY[
    'baykush_api',
    'baykush_ingest',
    'baykush_projection',
    'baykush_stream',
    'baykush_recovery'
  ] LOOP
    EXECUTE format(
      'ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT',
      capability
    );
    FOR inherited IN
      SELECT parent.rolname
      FROM pg_auth_members membership
      JOIN pg_roles parent ON parent.oid = membership.roleid
      JOIN pg_roles member ON member.oid = membership.member
      WHERE member.rolname = capability
    LOOP
      EXECUTE format('REVOKE %I FROM %I', inherited, capability);
    END LOOP;
  END LOOP;
END
$$;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public
  FROM baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;
GRANT USAGE ON SCHEMA public
  TO baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Deterministic baseline: a rerun on a fresh upgrade cannot inherit accidental
-- table or sequence grants from an earlier experiment.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Runtime planes need to read the public/global Node state they consume. The API
-- deliberately receives SELECT only and no sequence or mutation privilege.
GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Write authority is table-family scoped. Immutable truth tables may still have
-- INSERT permission where append-only ingestion requires it; their existing
-- immutability triggers continue to reject UPDATE/DELETE of immutable revisions.
DO $$
DECLARE
  item record;
  ingest_pattern text := '^(source_|collection_|raw_source_records$|canonical_evidence_records$|normalization_|historical_backfill_|runtime_heartbeats$)';
  projection_pattern text := '^(measurement_|source_coverage_|source_acquisition_|coverage_reconciliation_|entity_(observation|history|activity)_|convergence_|node7_|discovery_|geograph(ic|y)_|historical_backfill_requests$|routing_minute_bucket_|routing_measurement_dirty_minutes$|runtime_heartbeats$)';
  stream_pattern text := '^(stream_(capture_profile|sessions|session_events|segment|coverage_interval|recovery_requests|recovery_segments|retention_runs)|routing_segment_|routing_measurement_dirty_minutes$|runtime_heartbeats$)';
  recovery_pattern text := '^(stream_recovery_|routing_(minute_bucket|recovery_minute|measurement_dirty)_|runtime_heartbeats$)';
BEGIN
  FOR item IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  LOOP
    IF item.tablename ~ ingest_pattern THEN
      EXECUTE format('GRANT INSERT, UPDATE ON TABLE %I.%I TO baykush_ingest', item.schemaname, item.tablename);
    END IF;
    IF item.tablename ~ projection_pattern THEN
      EXECUTE format('GRANT INSERT, UPDATE ON TABLE %I.%I TO baykush_projection', item.schemaname, item.tablename);
    END IF;
    IF item.tablename ~ stream_pattern THEN
      EXECUTE format('GRANT INSERT, UPDATE ON TABLE %I.%I TO baykush_stream', item.schemaname, item.tablename);
    END IF;
    IF item.tablename ~ recovery_pattern THEN
      EXECUTE format('GRANT INSERT, UPDATE ON TABLE %I.%I TO baykush_recovery', item.schemaname, item.tablename);
    END IF;
  END LOOP;
END
$$;

-- DELETE is limited to the exact transient/work-queue surfaces whose owning
-- runtime executes retention or consumes dirty work. Immutable evidence and
-- revision tables never receive DELETE through these capability roles.
GRANT DELETE ON TABLE
  measurement_dirty_buckets,
  source_coverage_dirty_buckets,
  routing_measurement_dirty_minutes,
  entity_history_heads
TO baykush_projection;
GRANT DELETE ON TABLE stream_segment_payloads TO baykush_stream;

-- Future migrations must grant new table families explicitly. We intentionally
-- avoid ALTER DEFAULT PRIVILEGES because silent future privilege expansion would
-- defeat the least-privilege boundary.

COMMIT;

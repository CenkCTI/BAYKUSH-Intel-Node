BEGIN;

-- NODE-8 runtime roles are NOLOGIN capability groups. Production login roles are
-- provisioned out of band from host-private URL files; passwords never enter SQL migrations.
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
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION', role_name);
    END IF;
  END LOOP;
END
$$;

-- Public schema creation is unnecessary for application clients and makes a
-- compromised runtime credential more dangerous. The database owner/migrator
-- retains ownership and therefore migration capability.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Reset capability groups to a deterministic baseline on every fresh upgrade.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public
  FROM baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public
  FROM baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Every runtime needs read access to the public/global Node state it consumes.
GRANT SELECT ON ALL TABLES IN SCHEMA public
  TO baykush_api, baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Sequence usage is harmless without matching table INSERT privilege and is
-- required by tables that use sequence-backed defaults.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO baykush_ingest, baykush_projection, baykush_stream, baykush_recovery;

-- Grant DML only to the table families owned by each runtime plane.
DO $$
DECLARE
  item record;
  ingest_pattern text := '^(source_|collection_|raw_source_records$|canonical_evidence_records$|entity_observation_|entity_history_|normalization_|backfill_|runtime_heartbeats$)';
  projection_pattern text := '^(measurement_|node7_|entity_activity_|convergence_|discovery_|geographic_|runtime_heartbeats$)';
  stream_pattern text := '^(routing_|stream_|runtime_heartbeats$)';
  recovery_pattern text := '^(recovery_|routing_|stream_|runtime_heartbeats$)';
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

-- Retention/recovery deletion is deliberately narrow. Normal collectors and
-- projection workers never receive blanket DELETE permission.
DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT schemaname, tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename ~ '^(stream_|recovery_)'
  LOOP
    EXECUTE format('GRANT DELETE ON TABLE %I.%I TO baykush_recovery', item.schemaname, item.tablename);
  END LOOP;
END
$$;

-- Future migrations must grant capabilities explicitly when they introduce a
-- new runtime table family. We intentionally do not install ALTER DEFAULT
-- PRIVILEGES that would silently widen runtime access to unrelated future tables.

COMMIT;

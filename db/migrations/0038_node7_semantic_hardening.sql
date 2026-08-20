BEGIN;

-- NODE-7 semantic hardening is additive. Earlier derivation-policy revisions remain immutable
-- evidence of the pre-acceptance contract, while v2 becomes the active producer policy.

CREATE OR REPLACE FUNCTION node7_convergence_input_contributes(
  p_policy_revision_id uuid,
  p_observation_basis text,
  p_source_class text,
  p_source_key text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT NOT (
      COALESCE(r.config->'contextOnlyObservationBases', '[]'::jsonb) ? p_observation_basis
      OR COALESCE(r.config->'contextOnlySourceClasses', '[]'::jsonb) ? p_source_class
      OR COALESCE(r.config->'contextOnlySourceKeys', '[]'::jsonb) ? p_source_key
    )
    FROM node7_derivation_policy_revisions r
    WHERE r.id = p_policy_revision_id
      AND r.policy_kind = 'CONVERGENCE'
  ), false)
$$;

INSERT INTO node7_derivation_policy_revisions(
  policy_key, revision_number, policy_version, policy_kind, config,
  represents, does_not_represent, policy_sha256, supersedes_revision_id
)
SELECT
  'CONVERGENCE',
  current.revision_number + 1,
  'node7-convergence-v2-context-gated',
  'CONVERGENCE',
  '{
    "hourWindowHours": 1,
    "concurrentWindowHours": 1,
    "minimumSourceSystems": 2,
    "minimumUpstreamOrigins": 2,
    "identityMode": "EXACT_CANONICAL",
    "instantOnlyConcurrency": true,
    "contextOnlyObservationBases": ["SCORED"],
    "contextOnlySourceClasses": ["EXPLOIT_PROBABILITY", "CONTEXT_KNOWLEDGE", "ROUTING_TELEMETRY"],
    "contextOnlySourceKeys": ["FIRST_EPSS", "MITRE_ATTACK_ENTERPRISE"]
  }'::jsonb,
  'Deterministic exact-entity overlap among contributing technical source systems. Scoring/context sources remain visible as context but do not inflate source-system, upstream-origin, source-class or concurrency breadth.',
  'Causation, independent corroboration, exploitation, coordinated attack, attribution, maliciousness, risk, actor identity, strategic meaning, or context/scoring volume treated as independent convergence evidence.',
  repeat('0',64)::char(64),
  current.id
FROM node7_derivation_policy_heads head
JOIN node7_derivation_policy_revisions current ON current.id=head.current_revision_id
WHERE head.policy_key='CONVERGENCE';

INSERT INTO node7_derivation_policy_revisions(
  policy_key, revision_number, policy_version, policy_kind, config,
  represents, does_not_represent, policy_sha256, supersedes_revision_id
)
SELECT
  'DISCOVERY',
  current.revision_number + 1,
  'node7-discovery-v2-live-novelty',
  'DISCOVERY',
  '{
    "presets": ["24H", "7D", "30D"],
    "currentNoveltyAcquisitionBases": ["LIVE_INCREMENTAL"],
    "historicalNoveltyAcquisitionBases": ["INITIAL_BOOTSTRAP", "RECOVERY", "HISTORICAL_BACKFILL", "RESYNC", "REPAIR", "SNAPSHOT_RECONSTRUCTION"],
    "compositionExpansionOnly": true,
    "maxPageSize": 100
  }'::jsonb,
  'Deterministic first-seen and positive source-composition discovery. Only a first LIVE_INCREMENTAL observation may be labelled current novelty.',
  'Threat prioritization, severity, attack probability, current novelty manufactured by bootstrap/recovery/backfill/resync/repair, disappearance claims when coverage is incomplete, or a global threat score.',
  repeat('0',64)::char(64),
  current.id
FROM node7_derivation_policy_heads head
JOIN node7_derivation_policy_revisions current ON current.id=head.current_revision_id
WHERE head.policy_key='DISCOVERY';

CREATE OR REPLACE FUNCTION enforce_node7_activity_contributor_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  contributor_count integer;
  source_count integer;
  origin_count integer;
  class_count integer;
  instant_count integer;
  date_count integer;
BEGIN
  SELECT
    count(*)::integer,
    count(DISTINCT head.source_definition_id)::integer,
    count(DISTINCT source.upstream_origin_key)::integer,
    count(DISTINCT source.source_class)::integer,
    count(*) FILTER (WHERE revision.time_precision='INSTANT')::integer,
    count(*) FILTER (WHERE revision.time_precision='DATE')::integer
  INTO contributor_count, source_count, origin_count, class_count, instant_count, date_count
  FROM entity_observation_heads head
  JOIN entity_observation_revisions revision ON revision.id=head.current_revision_id
  JOIN source_definitions source ON source.id=head.source_definition_id
  WHERE head.entity_type=NEW.entity_type
    AND head.entity_key=NEW.entity_key
    AND head.state='ACTIVE'
    AND node7_convergence_input_contributes(
      NEW.policy_revision_id,
      revision.observation_basis,
      source.source_class,
      source.source_key
    )
    AND (
      (NEW.resolution='HOUR'
        AND head.observed_time >= NEW.bucket_start
        AND head.observed_time < NEW.bucket_end)
      OR
      (NEW.resolution='DAY' AND (
        (head.observed_time >= NEW.bucket_start AND head.observed_time < NEW.bucket_end)
        OR
        (head.observed_date >= NEW.bucket_start::date AND head.observed_date < NEW.bucket_end::date)
      ))
    );

  NEW.observation_count := contributor_count;
  NEW.source_definition_count := source_count;
  NEW.upstream_origin_count := origin_count;
  NEW.source_class_count := class_count;
  NEW.instant_observation_count := instant_count;
  NEW.date_observation_count := date_count;
  NEW.state := CASE WHEN contributor_count > 0 THEN 'ACTIVE' ELSE 'EMPTY' END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_activity_bucket_revisions_contributor_counts
BEFORE INSERT ON entity_activity_bucket_revisions
FOR EACH ROW EXECUTE FUNCTION enforce_node7_activity_contributor_counts();

CREATE OR REPLACE FUNCTION filter_node7_activity_member_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_id uuid;
BEGIN
  SELECT policy_revision_id INTO policy_id
  FROM entity_activity_bucket_revisions
  WHERE id=NEW.bucket_revision_id;

  IF policy_id IS NULL THEN
    RAISE EXCEPTION 'NODE-7 activity member references missing activity revision %', NEW.bucket_revision_id;
  END IF;

  IF NOT node7_convergence_input_contributes(
    policy_id,
    NEW.observation_basis,
    NEW.source_class,
    NEW.source_key
  ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_activity_bucket_members_context_filter
BEFORE INSERT ON entity_activity_bucket_members
FOR EACH ROW EXECUTE FUNCTION filter_node7_activity_member_context();

CREATE OR REPLACE FUNCTION filter_node7_activity_input_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  policy_id uuid;
  basis text;
  class_name text;
  key_name text;
BEGIN
  SELECT activity.policy_revision_id,
         observation.observation_basis,
         source.source_class,
         source.source_key
  INTO policy_id, basis, class_name, key_name
  FROM entity_activity_bucket_revisions activity
  JOIN entity_observation_revisions observation ON observation.id=NEW.entity_observation_revision_id
  JOIN source_definitions source ON source.id=observation.source_definition_id
  WHERE activity.id=NEW.bucket_revision_id;

  IF policy_id IS NULL THEN
    RAISE EXCEPTION 'NODE-7 activity input references missing activity/observation revision';
  END IF;

  IF NOT node7_convergence_input_contributes(policy_id, basis, class_name, key_name) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_activity_bucket_inputs_context_filter
BEFORE INSERT ON entity_activity_bucket_inputs
FOR EACH ROW EXECUTE FUNCTION filter_node7_activity_input_context();

CREATE OR REPLACE FUNCTION align_node7_activity_head_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  revision_state text;
BEGIN
  SELECT state INTO revision_state
  FROM entity_activity_bucket_revisions
  WHERE id=NEW.current_revision_id;
  IF revision_state IS NULL THEN
    RAISE EXCEPTION 'NODE-7 activity head references missing revision %', NEW.current_revision_id;
  END IF;
  NEW.state := revision_state;
  RETURN NEW;
END;
$$;

CREATE TRIGGER entity_activity_bucket_heads_state_alignment
BEFORE INSERT OR UPDATE OF current_revision_id,state ON entity_activity_bucket_heads
FOR EACH ROW EXECUTE FUNCTION align_node7_activity_head_state();

COMMIT;

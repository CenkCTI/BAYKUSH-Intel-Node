BEGIN;

CREATE TABLE node7_entity_capabilities (
  entity_type text PRIMARY KEY,
  convergence_enabled boolean NOT NULL,
  related_records_enabled boolean NOT NULL,
  geography_enabled boolean NOT NULL,
  routing_context_enabled boolean NOT NULL,
  novelty_enabled boolean NOT NULL,
  composition_enabled boolean NOT NULL,
  supported_time_precision text NOT NULL CHECK (supported_time_precision IN ('INSTANT','DATE','BOTH')),
  canonicalization_policy_version text NOT NULL,
  semantic_notes text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE node7_derivation_policy_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_key text NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  policy_version text NOT NULL,
  policy_kind text NOT NULL CHECK (policy_kind IN ('CONVERGENCE','DISCOVERY','GEOGRAPHY','ROUTING_CONTEXT')),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  represents text NOT NULL,
  does_not_represent text NOT NULL,
  policy_sha256 char(64) NOT NULL CHECK (policy_sha256 ~ '^[0-9a-f]{64}$'),
  supersedes_revision_id uuid REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (policy_key, revision_number),
  UNIQUE (policy_key, policy_version)
);

CREATE INDEX node7_derivation_policy_revisions_lookup_idx
  ON node7_derivation_policy_revisions(policy_key, revision_number DESC);

CREATE TABLE node7_derivation_policy_heads (
  policy_key text PRIMARY KEY,
  current_revision_id uuid NOT NULL UNIQUE REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION compute_node7_derivation_policy_sha256(p node7_derivation_policy_revisions)
RETURNS char(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'policy_key', p.policy_key,
    'revision_number', p.revision_number,
    'policy_version', p.policy_version,
    'policy_kind', p.policy_kind,
    'config', p.config,
    'represents', p.represents,
    'does_not_represent', p.does_not_represent,
    'supersedes_revision_id', CASE WHEN p.supersedes_revision_id IS NULL THEN NULL ELSE p.supersedes_revision_id::text END
  )::text, 'sha256'), 'hex')::char(64)
$$;

CREATE OR REPLACE FUNCTION prepare_node7_derivation_policy_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_id uuid;
  current_number integer;
BEGIN
  SELECT h.current_revision_id, r.revision_number
  INTO current_id, current_number
  FROM node7_derivation_policy_heads h
  JOIN node7_derivation_policy_revisions r ON r.id = h.current_revision_id
  WHERE h.policy_key = NEW.policy_key
  FOR UPDATE OF h;

  IF current_id IS NULL THEN
    IF NEW.revision_number <> 1 OR NEW.supersedes_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'first NODE-7 derivation policy revision must be revision 1 with no supersedes revision';
    END IF;
  ELSE
    IF NEW.revision_number <> current_number + 1 THEN
      RAISE EXCEPTION 'NODE-7 derivation policy revision must advance sequentially from % to %', current_number, current_number + 1;
    END IF;
    IF NEW.supersedes_revision_id IS DISTINCT FROM current_id THEN
      RAISE EXCEPTION 'NODE-7 derivation policy revision must supersede current head %', current_id;
    END IF;
  END IF;

  NEW.policy_sha256 := compute_node7_derivation_policy_sha256(NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER node7_derivation_policy_prepare_insert
BEFORE INSERT ON node7_derivation_policy_revisions
FOR EACH ROW EXECUTE FUNCTION prepare_node7_derivation_policy_revision();

CREATE OR REPLACE FUNCTION advance_node7_derivation_policy_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO node7_derivation_policy_heads(policy_key, current_revision_id, updated_at)
  VALUES (NEW.policy_key, NEW.id, now())
  ON CONFLICT (policy_key) DO UPDATE SET
    current_revision_id = EXCLUDED.current_revision_id,
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER node7_derivation_policy_advance_head
AFTER INSERT ON node7_derivation_policy_revisions
FOR EACH ROW EXECUTE FUNCTION advance_node7_derivation_policy_head();

CREATE OR REPLACE FUNCTION reject_node7_derivation_policy_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 derivation policy revisions are immutable; append a new revision instead';
END;
$$;

CREATE TRIGGER node7_derivation_policy_immutable_update
BEFORE UPDATE ON node7_derivation_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_derivation_policy_revision_mutation();

CREATE TRIGGER node7_derivation_policy_immutable_delete
BEFORE DELETE ON node7_derivation_policy_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_derivation_policy_revision_mutation();

CREATE VIEW current_node7_derivation_policies AS
SELECT
  h.policy_key,
  r.id AS revision_id,
  r.revision_number,
  r.policy_version,
  r.policy_kind,
  r.config,
  r.represents,
  r.does_not_represent,
  r.policy_sha256,
  r.created_at,
  (r.policy_sha256 = compute_node7_derivation_policy_sha256(r)) AS hash_valid
FROM node7_derivation_policy_heads h
JOIN node7_derivation_policy_revisions r ON r.id = h.current_revision_id;

INSERT INTO node7_entity_capabilities(
  entity_type, convergence_enabled, related_records_enabled, geography_enabled,
  routing_context_enabled, novelty_enabled, composition_enabled,
  supported_time_precision, canonicalization_policy_version, semantic_notes
) VALUES
  ('CVE', true, true, false, false, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical CVE identity only; no product-family or vulnerability-family fuzzy equivalence.'),
  ('IP', true, true, true, true, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical IP identity; geography and routing are contextual assertions, never attacker-origin attribution.'),
  ('DOMAIN', true, true, true, false, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical domain identity; current DNS resolution must not be backdated as historical location.'),
  ('URL', true, true, false, false, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical URL identity; no automatic equivalence with host/domain entities.'),
  ('HASH', true, true, false, false, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical hash identity including algorithm-qualified canonical key.'),
  ('CERTIFICATE', true, true, false, false, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical certificate identity; certificate observations do not imply host ownership or actor identity.'),
  ('ASN', true, true, true, false, true, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact canonical ASN identity; registration metadata is not physical infrastructure location.'),
  ('ATTACK_TECHNIQUE', true, true, false, false, false, true, 'BOTH', 'node7-exact-canonical-v1', 'Exact ATT&CK technique identity; contextual knowledge is not direct observation of malicious activity.')
ON CONFLICT (entity_type) DO NOTHING;

INSERT INTO node7_derivation_policy_revisions(
  policy_key, revision_number, policy_version, policy_kind, config,
  represents, does_not_represent, policy_sha256, supersedes_revision_id
) VALUES
  (
    'CONVERGENCE', 1, 'node7-convergence-v1', 'CONVERGENCE',
    '{"hourWindowHours":1,"concurrentWindowHours":6,"minimumSourceSystems":2,"minimumUpstreamOrigins":2,"identityMode":"EXACT_CANONICAL","instantOnlyConcurrency":true}'::jsonb,
    'Deterministic overlap and temporal co-observation around one exact canonical entity across source systems, upstream origins and source classes.',
    'Causation, exploitation, coordinated attack, attribution, maliciousness, risk, actor identity or strategic meaning.',
    repeat('0',64)::char(64), NULL
  ),
  (
    'DISCOVERY', 1, 'node7-discovery-v1', 'DISCOVERY',
    '{"presets":["24H","7D","30D"],"excludeCurrentNoveltyAcquisitionBases":["INITIAL_BOOTSTRAP","RECOVERY","HISTORICAL_BACKFILL","SNAPSHOT_RECONSTRUCTION"],"compositionExpansionOnly":true,"maxPageSize":100}'::jsonb,
    'Deterministic new-entity and source-composition change discovery with historical acquisition separated from current movement.',
    'Threat prioritization, severity, attack probability, disappearance claims when coverage is incomplete, or a global threat score.',
    repeat('0',64)::char(64), NULL
  ),
  (
    'GEOGRAPHY', 1, 'node7-geography-v1', 'GEOGRAPHY',
    '{"geoClasses":["OBSERVED_INFRASTRUCTURE_LOCATION","REPORTED_TARGET","REPORTED_ACTIVITY"],"allowAttackerOriginInference":false,"currentSnapshotBackdating":false,"maxMapCountries":250}'::jsonb,
    'Explicit-basis geographic assertions whose class, temporal policy and provenance remain visible.',
    'Attacker origin inference, nationality attribution, physical location inferred from ASN registration country, or historical location backfilled from a current-only lookup.',
    repeat('0',64)::char(64), NULL
  ),
  (
    'ROUTING_CONTEXT', 1, 'node7-routing-context-v1', 'ROUTING_CONTEXT',
    '{"supportedEntityTypes":["IP"],"maxRangeHours":24,"sourceKey":"RIPE_RIS_BGP","allowAttackInference":false,"allowOutageInference":false,"allowHijackInference":false}'::jsonb,
    'Bounded RIPE RIS routing context for already-observed canonical IP entities.',
    'Attack, outage, hijack, attacker-origin, victim-origin or complete global-Internet visibility.',
    repeat('0',64)::char(64), NULL
  );

COMMIT;

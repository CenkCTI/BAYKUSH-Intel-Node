BEGIN;

CREATE TABLE source_admission_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE CASCADE,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  policy_version text NOT NULL,
  admission_status text NOT NULL CHECK (admission_status IN (
    'CANDIDATE','RESEARCHED','EXPERIMENTAL','ADMITTED','ACTIVE','PAUSED','REJECTED','RETIRED'
  )),
  value_question text NOT NULL,
  official_access_reference text,
  terms_reference text,
  terms_checked_at timestamptz,
  review_due_at timestamptz,
  license_class text NOT NULL,
  commercial_use_status text NOT NULL CHECK (commercial_use_status IN (
    'UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE'
  )),
  redistribution_status text NOT NULL CHECK (redistribution_status IN (
    'UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE'
  )),
  raw_retention_status text NOT NULL CHECK (raw_retention_status IN (
    'UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE'
  )),
  canonical_retention_status text NOT NULL CHECK (canonical_retention_status IN (
    'UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE'
  )),
  derived_data_status text NOT NULL CHECK (derived_data_status IN (
    'UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE'
  )),
  public_display_status text NOT NULL CHECK (public_display_status IN (
    'UNKNOWN','ALLOWED','RESTRICTED','PROHIBITED','NOT_APPLICABLE'
  )),
  attribution_requirement text,
  collection_allowed boolean NOT NULL DEFAULT false,
  canonical_projection_allowed boolean NOT NULL DEFAULT false,
  measurement_projection_allowed boolean NOT NULL DEFAULT false,
  operator_constraints text,
  admission_sha256 char(64) NOT NULL,
  supersedes_revision_id uuid REFERENCES source_admission_revisions(id),
  reviewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_definition_id, revision_number),
  UNIQUE (source_definition_id, policy_version)
);

CREATE INDEX source_admission_revisions_source_idx
  ON source_admission_revisions(source_definition_id, revision_number DESC);

CREATE TABLE source_admission_heads (
  source_definition_id uuid PRIMARY KEY REFERENCES source_definitions(id) ON DELETE CASCADE,
  current_revision_id uuid NOT NULL UNIQUE REFERENCES source_admission_revisions(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION compute_source_admission_sha256(p source_admission_revisions)
RETURNS char(64)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT encode(digest(jsonb_build_object(
    'source_definition_id', p.source_definition_id::text,
    'revision_number', p.revision_number,
    'policy_version', p.policy_version,
    'admission_status', p.admission_status,
    'value_question', p.value_question,
    'official_access_reference', p.official_access_reference,
    'terms_reference', p.terms_reference,
    'terms_checked_at', p.terms_checked_at,
    'review_due_at', p.review_due_at,
    'license_class', p.license_class,
    'commercial_use_status', p.commercial_use_status,
    'redistribution_status', p.redistribution_status,
    'raw_retention_status', p.raw_retention_status,
    'canonical_retention_status', p.canonical_retention_status,
    'derived_data_status', p.derived_data_status,
    'public_display_status', p.public_display_status,
    'attribution_requirement', p.attribution_requirement,
    'collection_allowed', p.collection_allowed,
    'canonical_projection_allowed', p.canonical_projection_allowed,
    'measurement_projection_allowed', p.measurement_projection_allowed,
    'operator_constraints', p.operator_constraints,
    'supersedes_revision_id', CASE WHEN p.supersedes_revision_id IS NULL THEN NULL ELSE p.supersedes_revision_id::text END,
    'reviewed_at', p.reviewed_at
  )::text, 'sha256'), 'hex')::char(64)
$$;

CREATE OR REPLACE FUNCTION prepare_source_admission_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_id uuid;
  current_number integer;
BEGIN
  SELECT h.current_revision_id, r.revision_number
  INTO current_id, current_number
  FROM source_admission_heads h
  JOIN source_admission_revisions r ON r.id = h.current_revision_id
  WHERE h.source_definition_id = NEW.source_definition_id
  FOR UPDATE OF h;

  IF current_id IS NULL THEN
    IF NEW.revision_number <> 1 OR NEW.supersedes_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'first source admission revision must be revision 1 with no supersedes revision';
    END IF;
  ELSE
    IF NEW.revision_number <> current_number + 1 THEN
      RAISE EXCEPTION 'source admission revision must advance sequentially from % to %', current_number, current_number + 1;
    END IF;
    IF NEW.supersedes_revision_id IS DISTINCT FROM current_id THEN
      RAISE EXCEPTION 'source admission revision must supersede current head %', current_id;
    END IF;
  END IF;

  NEW.admission_sha256 := compute_source_admission_sha256(NEW);
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_admission_prepare_insert
BEFORE INSERT ON source_admission_revisions
FOR EACH ROW EXECUTE FUNCTION prepare_source_admission_revision();

CREATE OR REPLACE FUNCTION advance_source_admission_head()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO source_admission_heads(source_definition_id, current_revision_id, updated_at)
  VALUES (NEW.source_definition_id, NEW.id, now())
  ON CONFLICT (source_definition_id) DO UPDATE SET
    current_revision_id = EXCLUDED.current_revision_id,
    updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_admission_advance_head
AFTER INSERT ON source_admission_revisions
FOR EACH ROW EXECUTE FUNCTION advance_source_admission_head();

CREATE OR REPLACE FUNCTION reject_source_admission_revision_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source_admission_revisions are immutable; append a new policy revision instead';
END;
$$;

CREATE TRIGGER source_admission_immutable_update
BEFORE UPDATE ON source_admission_revisions
FOR EACH ROW EXECUTE FUNCTION reject_source_admission_revision_mutation();

CREATE TRIGGER source_admission_immutable_delete
BEFORE DELETE ON source_admission_revisions
FOR EACH ROW EXECUTE FUNCTION reject_source_admission_revision_mutation();

CREATE VIEW current_source_admissions AS
SELECT
  d.id AS source_definition_id,
  d.source_key,
  d.display_name,
  d.enabled,
  r.id AS revision_id,
  r.revision_number,
  r.policy_version,
  r.admission_status,
  r.value_question,
  r.official_access_reference,
  r.terms_reference,
  r.terms_checked_at,
  r.review_due_at,
  r.license_class,
  r.commercial_use_status,
  r.redistribution_status,
  r.raw_retention_status,
  r.canonical_retention_status,
  r.derived_data_status,
  r.public_display_status,
  r.attribution_requirement,
  r.collection_allowed,
  r.canonical_projection_allowed,
  r.measurement_projection_allowed,
  r.operator_constraints,
  r.admission_sha256,
  r.reviewed_at,
  r.created_at,
  (r.admission_sha256 = compute_source_admission_sha256(r)) AS hash_valid
FROM source_definitions d
LEFT JOIN source_admission_heads h ON h.source_definition_id = d.id
LEFT JOIN source_admission_revisions r ON r.id = h.current_revision_id;

INSERT INTO source_admission_revisions(
  source_definition_id,
  revision_number,
  policy_version,
  admission_status,
  value_question,
  official_access_reference,
  terms_reference,
  terms_checked_at,
  review_due_at,
  license_class,
  commercial_use_status,
  redistribution_status,
  raw_retention_status,
  canonical_retention_status,
  derived_data_status,
  public_display_status,
  attribution_requirement,
  collection_allowed,
  canonical_projection_allowed,
  measurement_projection_allowed,
  operator_constraints,
  admission_sha256,
  supersedes_revision_id,
  reviewed_at
)
SELECT
  d.id,
  1,
  'node5-bootstrap-v1',
  'ADMITTED',
  'Preserve the established pre-NODE-5 technical role: ' || d.represents,
  d.terms_reference,
  d.terms_reference,
  d.created_at,
  now() + interval '180 days',
  d.license_class,
  d.commercial_use_status,
  d.redistribution_status,
  CASE WHEN d.license_class = 'INTERNAL_TEST' THEN 'NOT_APPLICABLE' ELSE 'ALLOWED' END,
  CASE WHEN d.license_class = 'INTERNAL_TEST' THEN 'NOT_APPLICABLE' ELSE 'ALLOWED' END,
  CASE WHEN d.license_class = 'INTERNAL_TEST' THEN 'NOT_APPLICABLE' ELSE 'ALLOWED' END,
  d.redistribution_status,
  d.attribution_requirement,
  true,
  true,
  true,
  'NODE-5 bootstrap preserves the already-admitted NODE-2/NODE-4 source. Re-review source-specific terms under the NODE-5 admission process before material policy changes.',
  repeat('0', 64)::char(64),
  NULL,
  now()
FROM source_definitions d
WHERE NOT EXISTS (
  SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id = d.id
);

CREATE OR REPLACE FUNCTION enforce_source_admission_on_enable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  admission current_source_admissions%ROWTYPE;
BEGIN
  IF NEW.enabled = true AND OLD.enabled = false THEN
    SELECT * INTO admission
    FROM current_source_admissions
    WHERE source_definition_id = NEW.id;

    IF admission.revision_id IS NULL THEN
      RAISE EXCEPTION 'source % cannot be enabled without a current admission revision', NEW.source_key;
    END IF;
    IF admission.admission_status NOT IN ('ADMITTED','ACTIVE') THEN
      RAISE EXCEPTION 'source % cannot be enabled with admission status %', NEW.source_key, admission.admission_status;
    END IF;
    IF admission.hash_valid IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'source % admission policy integrity check failed', NEW.source_key;
    END IF;
    IF admission.collection_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'source % admission policy does not allow collection', NEW.source_key;
    END IF;
    IF admission.raw_retention_status IN ('UNKNOWN','PROHIBITED') THEN
      RAISE EXCEPTION 'source % raw retention policy does not permit the current Node raw-truth model', NEW.source_key;
    END IF;
    IF admission.canonical_projection_allowed IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'source % admission policy does not allow canonical projection', NEW.source_key;
    END IF;
    IF admission.license_class <> 'INTERNAL_TEST' AND admission.terms_checked_at IS NULL THEN
      RAISE EXCEPTION 'source % cannot be enabled before terms are checked', NEW.source_key;
    END IF;
    IF admission.review_due_at IS NOT NULL AND admission.review_due_at < now() THEN
      RAISE EXCEPTION 'source % admission review is overdue', NEW.source_key;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_definition_admission_enable_guard
BEFORE UPDATE OF enabled ON source_definitions
FOR EACH ROW EXECUTE FUNCTION enforce_source_admission_on_enable();

COMMIT;

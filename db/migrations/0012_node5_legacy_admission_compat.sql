BEGIN;

CREATE OR REPLACE FUNCTION bootstrap_pre_node5_source_admission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_key NOT IN (
    'TEST_SYNTHETIC',
    'CISA_KEV',
    'NVD_CVE',
    'FIRST_EPSS',
    'THREATFOX',
    'MALWAREBAZAAR'
  ) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id = NEW.id
  ) THEN
    RETURN NEW;
  END IF;

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
  ) VALUES (
    NEW.id,
    1,
    'node5-bootstrap-v1',
    'ADMITTED',
    'Preserve the established pre-NODE-5 technical role: ' || NEW.represents,
    NEW.terms_reference,
    NEW.terms_reference,
    NEW.created_at,
    now() + interval '180 days',
    NEW.license_class,
    NEW.commercial_use_status,
    NEW.redistribution_status,
    CASE WHEN NEW.license_class = 'INTERNAL_TEST' THEN 'NOT_APPLICABLE' ELSE 'ALLOWED' END,
    CASE WHEN NEW.license_class = 'INTERNAL_TEST' THEN 'NOT_APPLICABLE' ELSE 'ALLOWED' END,
    CASE WHEN NEW.license_class = 'INTERNAL_TEST' THEN 'NOT_APPLICABLE' ELSE 'ALLOWED' END,
    NEW.redistribution_status,
    NEW.attribution_requirement,
    true,
    true,
    true,
    'NODE-5 compatibility admission is restricted to the pre-NODE-5 production source allowlist. New NODE-5 sources require an explicit source-specific admission policy.',
    repeat('0', 64)::char(64),
    NULL,
    now()
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER source_definition_pre_node5_admission_compat
AFTER INSERT ON source_definitions
FOR EACH ROW EXECUTE FUNCTION bootstrap_pre_node5_source_admission();

COMMIT;

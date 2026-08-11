BEGIN;

ALTER TABLE source_definitions
  ADD COLUMN auth_requirement text NOT NULL DEFAULT 'NONE';

ALTER TABLE source_definitions
  ADD CONSTRAINT source_definitions_auth_requirement_check
  CHECK (auth_requirement IN ('NONE','OPTIONAL','REQUIRED'));

UPDATE source_definitions
SET auth_requirement = CASE WHEN requires_auth THEN 'REQUIRED' ELSE 'NONE' END;

COMMENT ON COLUMN source_definitions.auth_requirement IS
  'Tri-state source credential contract. NONE requires no credential, OPTIONAL can use one, REQUIRED cannot collect without one. Legacy requires_auth is retained for additive compatibility.';

COMMIT;

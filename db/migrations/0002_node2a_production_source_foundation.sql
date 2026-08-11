BEGIN;

ALTER TABLE collection_runs
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE collection_work_units
  ADD COLUMN available_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX collection_runs_available_claim_idx
  ON collection_runs(state, available_at, lease_expires_at, created_at);

CREATE INDEX collection_work_units_available_claim_idx
  ON collection_work_units(run_id, state, available_at, lease_expires_at, ordinal);

ALTER TABLE runtime_heartbeats
  DROP CONSTRAINT runtime_heartbeats_component_check;

ALTER TABLE runtime_heartbeats
  ADD CONSTRAINT runtime_heartbeats_component_check
  CHECK (component IN ('API','SCHEDULER','WORKER','NORMALIZER'));

CREATE TABLE normalization_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_record_id uuid NOT NULL REFERENCES raw_source_records(id) ON DELETE CASCADE,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id),
  normalization_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_expires_at timestamptz,
  canonical_records_written integer NOT NULL DEFAULT 0 CHECK (canonical_records_written >= 0),
  failure_code text,
  failure_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_record_id, normalization_version)
);

CREATE INDEX normalization_jobs_claim_idx
  ON normalization_jobs(state, available_at, lease_expires_at, created_at);

CREATE TABLE canonical_evidence_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_record_id uuid NOT NULL REFERENCES raw_source_records(id) ON DELETE RESTRICT,
  source_definition_id uuid NOT NULL REFERENCES source_definitions(id),
  source_record_id text NOT NULL,
  upstream_origin_key text NOT NULL,
  canonical_key text NOT NULL,
  record_kind text NOT NULL CHECK (record_kind IN (
    'VULNERABILITY_RECORD','KNOWN_EXPLOITED_VULNERABILITY','EXPLOIT_PROBABILITY_SCORE',
    'IOC_REPORT','MALWARE_SAMPLE_RECORD','SECURITY_ADVISORY','CERT_CSIRT_PUBLICATION',
    'THREAT_RESEARCH_REPORT','INFRASTRUCTURE_OBSERVATION','CONTEXT_KNOWLEDGE','UNKNOWN'
  )),
  received_at timestamptz NOT NULL,
  published_at timestamptz,
  effective_at timestamptz,
  upstream_updated_at timestamptz,
  entities jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(entities) = 'array'),
  facts jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(facts) = 'array'),
  references jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(references) = 'array'),
  semantic_boundary jsonb NOT NULL CHECK (jsonb_typeof(semantic_boundary) = 'object'),
  adapter_version text NOT NULL,
  normalization_version text NOT NULL,
  semantic_contract_version text NOT NULL,
  normalized_sha256 char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (raw_record_id, normalization_version, canonical_key, record_kind)
);

CREATE INDEX canonical_evidence_source_record_idx
  ON canonical_evidence_records(source_definition_id, source_record_id, created_at DESC);

CREATE INDEX canonical_evidence_key_idx
  ON canonical_evidence_records(canonical_key, effective_at DESC NULLS LAST);

CREATE OR REPLACE FUNCTION reject_canonical_evidence_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'canonical_evidence_records are immutable; create a new normalization version instead';
END;
$$;

CREATE TRIGGER canonical_evidence_immutable_update
BEFORE UPDATE ON canonical_evidence_records
FOR EACH ROW EXECUTE FUNCTION reject_canonical_evidence_update();

COMMIT;

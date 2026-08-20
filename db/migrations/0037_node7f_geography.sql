BEGIN;

INSERT INTO source_definitions (
  source_key,display_name,provider_name,upstream_origin_key,source_class,observation_basis,
  authority_type,collection_mode,default_poll_interval_seconds,minimum_poll_interval_seconds,
  supports_historical_retrieval,recovery_strategy,historical_max_window_seconds,requires_auth,
  credential_kind,adapter_version,semantic_contract_version,license_class,
  commercial_use_status,redistribution_status,attribution_requirement,terms_reference,
  represents,does_not_represent,enabled_by_default,enabled
) VALUES (
  'IPINFO_LITE','IPinfo Lite','IPinfo','IPINFO_LITE','CONTEXT_KNOWLEDGE','ENRICHED',
  'third-party-enrichment','POLL',NULL,NULL,false,'LIVE_ONLY',NULL,true,
  'IPINFO_LITE_TOKEN','node7-ipinfo-lite-v1','node7-geography-v1','CC-BY-SA-4.0',
  'ALLOWED','RESTRICTED','IP address data powered by IPinfo','https://ipinfo.io/developers/lite-api',
  'Current country-level IP geolocation and basic ASN context for already-observed canonical IP entities.',
  'Attacker origin, actor nationality, historical IP location, city/region/coordinates, maliciousness, victim location, or physical location inferred from ASN registration.',
  false,false
) ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_admission_revisions(
  source_definition_id,revision_number,policy_version,admission_status,value_question,
  official_access_reference,terms_reference,terms_checked_at,review_due_at,license_class,
  commercial_use_status,redistribution_status,raw_retention_status,canonical_retention_status,
  derived_data_status,public_display_status,attribution_requirement,collection_allowed,
  canonical_projection_allowed,measurement_projection_allowed,operator_constraints,
  admission_sha256,supersedes_revision_id,reviewed_at
)
SELECT
  source.id,1,'node7-ipinfo-lite-admission-v1','ADMITTED',
  'For canonical IPs already observed by BAYKUSH, what current country-level location and basic ASN context does IPinfo Lite return?',
  'https://ipinfo.io/developers/lite-api','https://ipinfo.io/developers/database-types',now(),now()+interval '90 days',
  'CC-BY-SA-4.0','ALLOWED','RESTRICTED','PROHIBITED','ALLOWED','ALLOWED','ALLOWED',
  'IP address data powered by IPinfo',true,true,false,
  'NODE-7 uses the authenticated Lite API only as bounded current-snapshot enrichment. Raw provider responses are not retained. Public display must preserve attribution. The source remains disabled for the generic scheduler and is invoked only by the NODE-7 geography worker for already-observed canonical IP entities.',
  repeat('0',64)::char(64),NULL,now()
FROM source_definitions source
WHERE source.source_key='IPINFO_LITE'
  AND NOT EXISTS (
    SELECT 1 FROM source_admission_heads head WHERE head.source_definition_id=source.id
  );

CREATE TABLE geographic_assertion_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assertion_key char(64) NOT NULL CHECK (assertion_key ~ '^[0-9a-f]{64}$'),
  revision_number integer NOT NULL CHECK (revision_number > 0),
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  subject_entity_type text NOT NULL,
  subject_entity_key text NOT NULL,
  geo_class text NOT NULL CHECK (geo_class IN (
    'OBSERVED_INFRASTRUCTURE_LOCATION','REPORTED_TARGET','REPORTED_ACTIVITY'
  )),
  country_code char(2),
  country_name text,
  continent_code char(2),
  continent_name text,
  region_code text,
  region_name text,
  city_name text,
  latitude double precision,
  longitude double precision,
  location_precision text NOT NULL CHECK (location_precision IN ('COUNTRY','REGION','CITY','COORDINATE','UNKNOWN')),
  basis_type text NOT NULL CHECK (basis_type IN (
    'IP_GEO_PROVIDER_CURRENT_SNAPSHOT','EXPLICIT_SOURCE_REPORT','EXPLICIT_SOURCE_TARGET','EXPLICIT_SOURCE_ACTIVITY'
  )),
  basis_source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  observed_time timestamptz,
  observed_date date,
  time_precision text NOT NULL CHECK (time_precision IN ('INSTANT','DATE')),
  valid_from timestamptz,
  valid_to timestamptz,
  temporal_policy text NOT NULL CHECK (temporal_policy IN ('HISTORICAL','CURRENT_SNAPSHOT_ONLY')),
  quality_class text NOT NULL,
  provider_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_context)='object'),
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  input_fingerprint char(64) NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_id uuid REFERENCES geographic_assertion_revisions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(observed_time,observed_date)=1),
  CHECK ((time_precision='INSTANT' AND observed_time IS NOT NULL) OR (time_precision='DATE' AND observed_date IS NOT NULL)),
  CHECK (num_nonnulls(latitude,longitude) IN (0,2)),
  CHECK (latitude IS NULL OR (latitude>=-90 AND latitude<=90)),
  CHECK (longitude IS NULL OR (longitude>=-180 AND longitude<=180)),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to>valid_from),
  UNIQUE (assertion_key,revision_number)
);

CREATE INDEX geographic_assertion_revisions_subject_idx
  ON geographic_assertion_revisions(subject_entity_type,subject_entity_key,created_at DESC);
CREATE INDEX geographic_assertion_revisions_country_idx
  ON geographic_assertion_revisions(geo_class,country_code,created_at DESC)
  WHERE state='ACTIVE' AND country_code IS NOT NULL;

CREATE TABLE geographic_assertion_heads (
  assertion_key char(64) PRIMARY KEY CHECK (assertion_key ~ '^[0-9a-f]{64}$'),
  current_revision_id uuid NOT NULL UNIQUE REFERENCES geographic_assertion_revisions(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('ACTIVE','RETRACTED')),
  subject_entity_type text NOT NULL,
  subject_entity_key text NOT NULL,
  geo_class text NOT NULL CHECK (geo_class IN (
    'OBSERVED_INFRASTRUCTURE_LOCATION','REPORTED_TARGET','REPORTED_ACTIVITY'
  )),
  basis_source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  observed_time timestamptz,
  observed_date date,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (num_nonnulls(observed_time,observed_date)=1)
);

CREATE INDEX geographic_assertion_heads_subject_idx
  ON geographic_assertion_heads(subject_entity_type,subject_entity_key,state,updated_at DESC);
CREATE INDEX geographic_assertion_heads_class_idx
  ON geographic_assertion_heads(geo_class,state,updated_at DESC);

CREATE TABLE geographic_assertion_inputs (
  assertion_revision_id uuid PRIMARY KEY REFERENCES geographic_assertion_revisions(id) ON DELETE CASCADE,
  entity_history_revision_id uuid REFERENCES entity_history_revisions(id) ON DELETE RESTRICT,
  canonical_record_id uuid REFERENCES canonical_evidence_records(id) ON DELETE RESTRICT,
  raw_record_id uuid REFERENCES raw_source_records(id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(entity_history_revision_id,canonical_record_id) >= 1)
);

CREATE TABLE geography_projection_receipts (
  subject_entity_type text NOT NULL,
  subject_entity_key text NOT NULL,
  provider_source_definition_id uuid NOT NULL REFERENCES source_definitions(id) ON DELETE RESTRICT,
  policy_revision_id uuid NOT NULL REFERENCES node7_derivation_policy_revisions(id) ON DELETE RESTRICT,
  lookup_date date NOT NULL,
  assertion_revision_id uuid REFERENCES geographic_assertion_revisions(id) ON DELETE SET NULL,
  looked_up_at timestamptz NOT NULL,
  provider_response_sha256 char(64) NOT NULL CHECK (provider_response_sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (subject_entity_type,subject_entity_key,provider_source_definition_id,policy_revision_id,lookup_date)
);

CREATE OR REPLACE FUNCTION reject_node7_geographic_assertion_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE-7 geographic assertion revisions are immutable; append a new revision instead';
END; $$;

CREATE TRIGGER geographic_assertion_revisions_immutable_update
BEFORE UPDATE ON geographic_assertion_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_geographic_assertion_mutation();
CREATE TRIGGER geographic_assertion_revisions_immutable_delete
BEFORE DELETE ON geographic_assertion_revisions
FOR EACH ROW EXECUTE FUNCTION reject_node7_geographic_assertion_mutation();

COMMIT;

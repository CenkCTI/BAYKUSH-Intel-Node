BEGIN;

INSERT INTO source_definitions(
  source_key, display_name, provider_name, upstream_origin_key,
  source_class, observation_basis, authority_type, collection_mode,
  default_poll_interval_seconds, minimum_poll_interval_seconds,
  supports_historical_retrieval, recovery_strategy, historical_max_window_seconds,
  requires_auth, auth_requirement, credential_kind, adapter_version, semantic_contract_version,
  license_class, commercial_use_status, redistribution_status,
  attribution_requirement, terms_reference, represents, does_not_represent,
  enabled_by_default, enabled
) VALUES (
  'SSLBL_CERTIFICATE', 'SSLBL Malicious SSL Certificates', 'abuse.ch', 'SSLBL',
  'IOC_SHARING', 'REPORTED', 'THREAT_FEED_PROVIDER', 'SNAPSHOT',
  900, 300, false, 'SNAPSHOT_RECONSTRUCTION', NULL,
  false, 'NONE', NULL, 'sslbl-certificate-adapter-v1', 'sslbl-certificate-semantics-v1',
  'CC0-1.0', 'ALLOWED', 'ALLOWED',
  'CC0 does not require attribution; retain an SSLBL source reference and do not imply abuse.ch endorsement.',
  'https://sslbl.abuse.ch/blacklist/',
  'SHA1 certificate fingerprints published by SSLBL as associated with malicious or botnet command-and-control activity, with SSLBL listing time and reason.',
  'Global TLS activity, certificate compromise proof, BAYKUSH sensor observations, attack count, victim count, infection count, organization compromise, attribution truth, or global threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='SSLBL_CERTIFICATE'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='SSLBL_CERTIFICATE'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_admission_revisions(
  source_definition_id, revision_number, policy_version, admission_status,
  value_question, official_access_reference, terms_reference, terms_checked_at,
  review_due_at, license_class, commercial_use_status, redistribution_status,
  raw_retention_status, canonical_retention_status, derived_data_status,
  public_display_status, attribution_requirement, collection_allowed,
  canonical_projection_allowed, measurement_projection_allowed, operator_constraints,
  admission_sha256, supersedes_revision_id, reviewed_at
)
SELECT
  d.id, 1, 'sslbl-certificate-admission-v1', 'ADMITTED',
  'Which SHA1 certificate fingerprints does SSLBL publish as associated with malicious or botnet command-and-control activity?',
  'https://sslbl.abuse.ch/blacklist/',
  'https://sslbl.abuse.ch/blacklist/',
  '2026-08-13T21:40:00Z'::timestamptz,
  '2027-02-13T00:00:00Z'::timestamptz,
  'CC0-1.0', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED',
  'CC0 does not require attribution; BAYKUSH retains the SSLBL source reference and must not imply abuse.ch endorsement.',
  true, true, true,
  'Use the official malicious SSL certificate SHA1 blacklist. Do not interpret certificate listings as attacks, victims, infections, TLS prevalence, attribution, or global threat level. The deprecated SSLBL C2 IP CSV is not admitted as a production source.',
  repeat('0',64)::char(64), NULL, '2026-08-13T21:40:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='SSLBL_CERTIFICATE'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

COMMIT;

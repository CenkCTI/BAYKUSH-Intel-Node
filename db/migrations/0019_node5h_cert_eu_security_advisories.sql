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
  'CERT_EU_SECURITY_ADVISORY', 'CERT-EU Security Advisory Publications', 'CERT-EU', 'CERT_EU_SECURITY_ADVISORY_RSS',
  'CERT_CSIRT_REPORTING', 'PUBLISHED', 'EU_CERT', 'SNAPSHOT',
  3600, 900, false, 'LIVE_ONLY', NULL,
  false, 'NONE', NULL, 'cert-eu-publication-adapter-v1', 'cert-eu-publication-semantics-v1',
  'CC-BY-4.0', 'ALLOWED', 'ALLOWED',
  'Retain CERT-EU attribution and source links.',
  'https://cert.europa.eu/legal-notice',
  'Security-advisory publications syndicated by CERT-EU on its official category feed.',
  'The full advisory body, complete historical coverage, exploitation confirmation, attacks, victims, exposure, business risk, attribution truth, or global threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='CERT_EU_SECURITY_ADVISORY'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='CERT_EU_SECURITY_ADVISORY'
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
  d.id, 1, 'cert-eu-publication-admission-v1', 'ADMITTED',
  'Which security-advisory publications are syndicated by CERT-EU on its official category feed?',
  'https://cert.europa.eu/publications/security-advisories-rss',
  'https://cert.europa.eu/legal-notice',
  '2026-08-13T23:50:00Z'::timestamptz,
  '2027-02-14T00:00:00Z'::timestamptz,
  'CC-BY-4.0', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED',
  'Retain CERT-EU attribution and source links.',
  true, true, false,
  'Treat this as a recent publication feed. Do not claim complete historical coverage or project publication counts into authoritative cyber-activity measurements without a separate coverage contract.',
  repeat('0',64)::char(64), NULL, '2026-08-13T23:50:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='CERT_EU_SECURITY_ADVISORY'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

COMMIT;

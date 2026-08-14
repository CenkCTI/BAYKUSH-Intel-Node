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
  'CISA_ICS_CSAF', 'CISA ICS CSAF Advisories', 'Cybersecurity and Infrastructure Security Agency (CISA)', 'CISA_CSAF_OT_WHITE',
  'OFFICIAL_ADVISORY', 'PUBLISHED', 'GOVERNMENT_COORDINATOR', 'PAGED_POLL',
  21600, 3600, true, 'SNAPSHOT_RECONSTRUCTION', NULL,
  false, 'NONE', NULL, 'cisa-ics-csaf-adapter-v1', 'cisa-ics-csaf-semantics-v1',
  'CISA_CSAF_MIXED_PUBLISHER', 'RESTRICTED', 'RESTRICTED',
  'Retain CISA and original publisher references. Preserve source-specific notices for vendor-partner republications and do not imply CISA endorsement.',
  'https://www.cisa.gov/notification',
  'Operational Technology security advisories distributed through CISA''s official CSAF repository, including CISA-produced and explicitly republished partner documents.',
  'Independent exploitation confirmation, attack count, victim count, organization exposure, remediation priority, business risk, attribution truth, or global threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='CISA_ICS_CSAF'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='CISA_ICS_CSAF'
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
  d.id, 1, 'cisa-ics-csaf-admission-v1', 'ADMITTED',
  'Which Operational Technology security advisories are distributed through CISA''s official CSAF repository?',
  'https://github.com/cisagov/CSAF', 'https://www.cisa.gov/notification',
  '2026-08-13T23:45:00Z'::timestamptz, '2026-11-14T00:00:00Z'::timestamptz,
  'CISA_CSAF_MIXED_PUBLISHER', 'RESTRICTED', 'RESTRICTED', 'ALLOWED', 'ALLOWED', 'RESTRICTED', 'RESTRICTED',
  'Retain CISA and original publisher references. Preserve source-specific notices for vendor-partner republications and do not imply CISA endorsement.',
  true, true, true,
  'Collect only OT/white CSAF documents. Publication/revision measurements describe advisory distribution only and must never be labelled exploitation, attack, victim, exposure, risk, attribution, or global threat. Preserve partner notices for republications.',
  repeat('0',64)::char(64), NULL, '2026-08-13T23:45:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='CISA_ICS_CSAF'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

COMMIT;

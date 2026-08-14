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
  'MITRE_ATTACK_ENTERPRISE', 'MITRE ATT&CK Enterprise Techniques', 'MITRE', 'MITRE_ATTACK',
  'CONTEXT_KNOWLEDGE', 'PUBLISHED', 'AUTHORITATIVE_KNOWLEDGE_BASE', 'SNAPSHOT',
  86400, 3600, false, 'SNAPSHOT_RECONSTRUCTION', NULL,
  false, 'NONE', NULL, 'mitre-attack-enterprise-adapter-v1', 'mitre-attack-enterprise-semantics-v1',
  'MITRE_ATTACK_TERMS', 'ALLOWED', 'RESTRICTED',
  'Reproduce MITRE copyright and ATT&CK license notices when copying the data; preserve attribution and do not imply MITRE endorsement.',
  'https://attack.mitre.org/resources/terms-of-use/',
  'Published MITRE ATT&CK Enterprise technique and sub-technique knowledge from official STIX data.',
  'Observed technique use, event frequency, campaign confirmation, attribution conclusions, organization compromise, or threat-level measurement.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='MITRE_ATTACK_ENTERPRISE'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='MITRE_ATTACK_ENTERPRISE'
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
  d.id, 1, 'mitre-attack-enterprise-admission-v1', 'ADMITTED',
  'What Enterprise techniques and sub-techniques are currently published in the official MITRE ATT&CK knowledge base?',
  'https://attack.mitre.org/resources/attack-data-and-tools/',
  'https://attack.mitre.org/resources/terms-of-use/',
  '2026-08-13T23:15:00Z'::timestamptz,
  '2027-02-14T00:00:00Z'::timestamptz,
  'MITRE_ATTACK_TERMS', 'ALLOWED', 'RESTRICTED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'RESTRICTED',
  'Reproduce MITRE copyright and ATT&CK license notices when copying the data; preserve attribution and do not imply MITRE endorsement.',
  true, true, false,
  'Context-only source. Do not project ATT&CK publication counts or changes into activity measurements; do not infer technique prevalence, campaigns, attribution, organization compromise, or threat level.',
  repeat('0',64)::char(64), NULL, '2026-08-13T23:15:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='MITRE_ATTACK_ENTERPRISE'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

COMMIT;

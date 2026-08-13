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
  'FEODO_TRACKER', 'Feodo Tracker public IOC dataset', 'abuse.ch', 'FEODO_TRACKER',
  'IOC_SHARING', 'REPORTED', 'THREAT_FEED_PROVIDER', 'SNAPSHOT',
  900, 300, false, 'SNAPSHOT_RECONSTRUCTION', NULL,
  false, 'NONE', NULL, 'feodo-tracker-adapter-v1', 'feodo-tracker-semantics-v1',
  'CC0-1.0', 'ALLOWED', 'ALLOWED',
  'CC0 does not require attribution; retain the provider source reference and do not imply endorsement.',
  'https://feodotracker.abuse.ch/blocklist/',
  'Public IOC records published by Feodo Tracker in its non-aggressive dataset.',
  'BAYKUSH sensor observations, attack count, victim count, infection count, population size, organization compromise, attribution truth, or global threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='FEODO_TRACKER'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='FEODO_TRACKER'
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
  d.id, 1, 'feodo-tracker-admission-v1', 'ADMITTED',
  'Which endpoints are published by Feodo Tracker in its non-aggressive IOC dataset?',
  'https://feodotracker.abuse.ch/blocklist/',
  'https://feodotracker.abuse.ch/blocklist/',
  '2026-08-13T21:20:00Z'::timestamptz,
  '2027-02-13T00:00:00Z'::timestamptz,
  'CC0-1.0', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED',
  'CC0 does not require attribution; BAYKUSH retains the Feodo Tracker source reference and must not imply abuse.ch endorsement.',
  true, true, true,
  'Use only the non-aggressive Feodo Tracker IOC JSON dataset. Do not interpret report counts as attacks, victims, infections, population, attribution, or global threat level.',
  repeat('0',64)::char(64), NULL, '2026-08-13T21:20:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='FEODO_TRACKER'
  AND NOT EXISTS (
    SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id
  );

COMMIT;

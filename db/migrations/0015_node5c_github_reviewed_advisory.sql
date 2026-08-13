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
  'GITHUB_ADVISORY_REVIEWED', 'GitHub Advisory Database — Reviewed', 'GitHub', 'GITHUB_ADVISORY_DATABASE_REVIEWED',
  'VULNERABILITY_DATABASE', 'PUBLISHED', 'CURATED_ADVISORY_AGGREGATOR', 'PAGED_POLL',
  3600, 300, true, 'HISTORICAL_QUERY', 604800,
  false, 'NONE', NULL, 'github-reviewed-advisory-adapter-v1', 'github-reviewed-advisory-semantics-v1',
  'CC-BY-4.0', 'ALLOWED', 'ALLOWED',
  'Preserve attribution to the GitHub Advisory Database and CC-BY-4.0 when sharing licensed or adapted material.',
  'https://github.com/github/advisory-database/blob/main/LICENSE.md',
  'GitHub-reviewed security advisories published through the GitHub Advisory Database and mapped to supported package ecosystems.',
  'Unreviewed NVD-derived advisories, malware advisories, exploitation events, attack count, package installation prevalence, organization exposure, business risk, or global threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='GITHUB_ADVISORY_REVIEWED'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='GITHUB_ADVISORY_REVIEWED'
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
  d.id, 1, 'github-reviewed-advisory-admission-v1', 'ADMITTED',
  'Which reviewed package-ecosystem security advisories are published through the GitHub Advisory Database?',
  'https://docs.github.com/en/rest/security-advisories/global-advisories',
  'https://github.com/github/advisory-database/blob/main/LICENSE.md',
  '2026-08-13T22:10:00Z'::timestamptz,
  '2027-02-13T00:00:00Z'::timestamptz,
  'CC-BY-4.0', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED', 'ALLOWED',
  'Preserve attribution to the GitHub Advisory Database and CC-BY-4.0 when sharing licensed or adapted material.',
  true, true, true,
  'Collect only type=reviewed advisories. Do not admit unreviewed advisories as independent evidence because GitHub documents them as automatically published from NVD. Exclude malware advisories from this source contract. Preserve affected version structures without inventing package-risk judgements.',
  repeat('0',64)::char(64), NULL, '2026-08-13T22:10:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='GITHUB_ADVISORY_REVIEWED'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

COMMIT;

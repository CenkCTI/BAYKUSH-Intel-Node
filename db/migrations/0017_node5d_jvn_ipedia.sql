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
  'JVN_IPEDIA', 'JVN iPedia Recent Vulnerability Advisories', 'JVN iPedia (IPA / JPCERT/CC)', 'JVN_IPEDIA',
  'VULNERABILITY_DATABASE', 'PUBLISHED', 'NATIONAL_VULNERABILITY_DATABASE', 'POLL',
  3600, 900, false, 'LIVE_ONLY', NULL,
  false, 'NONE', NULL, 'jvn-ipedia-adapter-v1', 'jvn-ipedia-semantics-v1',
  'JVN_FEED_TERMS', 'ALLOWED', 'RESTRICTED',
  'Retain JVN/JVN iPedia attribution and source links; syndicated content should not be represented as more current than the publisher source.',
  'https://jvn.jp/en/rss/',
  'Vulnerability countermeasure entries exposed by the official English JVN iPedia New and New/Updated JVNRSS feeds.',
  'A complete historical advisory corpus, independent exploitation confirmation, attack count, organization exposure, business risk, or global threat level.',
  false, false
)
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO source_schedule_state(source_definition_id, next_due_at)
SELECT id, now() FROM source_definitions WHERE source_key='JVN_IPEDIA'
ON CONFLICT (source_definition_id) DO NOTHING;

INSERT INTO source_health(source_definition_id, health_status)
SELECT id, 'PAUSED' FROM source_definitions WHERE source_key='JVN_IPEDIA'
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
  d.id, 1, 'jvn-ipedia-admission-v1', 'ADMITTED',
  'Which vulnerability countermeasure entries are newly published or updated through the official English JVN iPedia recent feeds?',
  'https://jvndb.jvn.jp/en/feed/', 'https://jvn.jp/en/rss/',
  '2026-08-13T23:30:00Z'::timestamptz, '2026-11-14T00:00:00Z'::timestamptz,
  'JVN_FEED_TERMS', 'ALLOWED', 'RESTRICTED', 'ALLOWED', 'ALLOWED', 'RESTRICTED', 'RESTRICTED',
  'Retain JVN/JVN iPedia attribution and source links. Treat syndicated content as a snapshot at syndication time and direct users to JVN or the relevant vendor for latest information.',
  true, true, false,
  'Use only the official English JVN iPedia New and New/Updated JVNRSS feeds. The recent feed surface is not complete historical coverage; measurement projection is intentionally disabled.',
  repeat('0',64)::char(64), NULL, '2026-08-13T23:30:00Z'::timestamptz
FROM source_definitions d
WHERE d.source_key='JVN_IPEDIA'
  AND NOT EXISTS (SELECT 1 FROM source_admission_heads h WHERE h.source_definition_id=d.id);

COMMIT;

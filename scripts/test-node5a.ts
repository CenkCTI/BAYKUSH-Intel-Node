import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { setSourceEnabled } from "../src/runtime/repository.js";
import {
  getCurrentSourceAdmission,
  syncAdmissionPolicy,
} from "../src/sources/admission/repository.js";

const sourceKey = "NODE5_ADMISSION_TEST";

async function reset(): Promise<string> {
  await pool.query("DELETE FROM source_definitions WHERE source_key = $1", [sourceKey]);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO source_definitions(
       source_key, display_name, provider_name, upstream_origin_key,
       source_class, observation_basis, authority_type, collection_mode,
       default_poll_interval_seconds, supports_historical_retrieval, recovery_strategy,
       requires_auth, auth_requirement, adapter_version, semantic_contract_version,
       license_class, commercial_use_status, redistribution_status,
       represents, does_not_represent, enabled_by_default, enabled
     ) VALUES (
       $1, 'NODE-5 Admission Test', 'BAYKUSH', 'BAYKUSH_TEST',
       'UNKNOWN', 'UNKNOWN', 'internal-test', 'POLL',
       60, false, 'LIVE_ONLY', false, 'NONE', 'node5-test-v1', 'node5-test-sem-v1',
       'INTERNAL_TEST', 'NOT_APPLICABLE', 'NOT_APPLICABLE',
       'Deterministic admission-gate acceptance state.', 'Real external cyber activity.', false, false
     ) RETURNING id`,
    [sourceKey],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  await pool.query("INSERT INTO source_schedule_state(source_definition_id, next_due_at) VALUES ($1, now())", [id]);
  await pool.query("INSERT INTO source_health(source_definition_id, health_status) VALUES ($1, 'PAUSED')", [id]);
  return id;
}

async function main(): Promise<void> {
  const sourceDefinitionId = await reset();

  await assert.rejects(() => setSourceEnabled(sourceKey, true), /admission/i);

  const reviewedAt = new Date().toISOString();
  await syncAdmissionPolicy({
    sourceKey,
    policyVersion: "node5-test-experimental-v1",
    admissionStatus: "EXPERIMENTAL",
    valueQuestion: "Can the admission gate reject a non-admitted source?",
    officialAccessReference: null,
    termsReference: null,
    termsCheckedAt: null,
    reviewDueAt: null,
    licenseClass: "INTERNAL_TEST",
    commercialUseStatus: "NOT_APPLICABLE",
    redistributionStatus: "NOT_APPLICABLE",
    rawRetentionStatus: "NOT_APPLICABLE",
    canonicalRetentionStatus: "NOT_APPLICABLE",
    derivedDataStatus: "NOT_APPLICABLE",
    publicDisplayStatus: "NOT_APPLICABLE",
    attributionRequirement: null,
    collectionAllowed: true,
    canonicalProjectionAllowed: true,
    measurementProjectionAllowed: true,
    operatorConstraints: "Test-only source.",
    reviewedAt,
  });
  await assert.rejects(() => setSourceEnabled(sourceKey, true), /status EXPERIMENTAL|STATUS_EXPERIMENTAL/i);

  await syncAdmissionPolicy({
    sourceKey,
    policyVersion: "node5-test-admitted-v2",
    admissionStatus: "ADMITTED",
    valueQuestion: "Can an explicitly admitted internal test source pass the gate?",
    officialAccessReference: null,
    termsReference: null,
    termsCheckedAt: null,
    reviewDueAt: null,
    licenseClass: "INTERNAL_TEST",
    commercialUseStatus: "NOT_APPLICABLE",
    redistributionStatus: "NOT_APPLICABLE",
    rawRetentionStatus: "NOT_APPLICABLE",
    canonicalRetentionStatus: "NOT_APPLICABLE",
    derivedDataStatus: "NOT_APPLICABLE",
    publicDisplayStatus: "NOT_APPLICABLE",
    attributionRequirement: null,
    collectionAllowed: true,
    canonicalProjectionAllowed: true,
    measurementProjectionAllowed: true,
    operatorConstraints: "Test-only source.",
    reviewedAt,
  });

  const admission = await getCurrentSourceAdmission(sourceKey);
  assert.ok(admission);
  assert.equal(admission.revisionNumber, 2);
  assert.equal(admission.admissionStatus, "ADMITTED");
  assert.equal(admission.hashValid, true);

  await setSourceEnabled(sourceKey, true);
  const enabled = await pool.query<{ enabled: boolean }>("SELECT enabled FROM source_definitions WHERE id = $1", [sourceDefinitionId]);
  assert.equal(enabled.rows[0]?.enabled, true);

  await assert.rejects(
    () => pool.query("UPDATE source_admission_revisions SET value_question = 'tampered' WHERE id = $1", [admission.revisionId]),
    /immutable/i,
  );

  await setSourceEnabled(sourceKey, false);
  await pool.query("DELETE FROM source_definitions WHERE id = $1", [sourceDefinitionId]);
  console.log("NODE-5A source admission acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

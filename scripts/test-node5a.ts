import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { pool } from "../src/db/pool.js";

const sourceKey = "NODE5_ADMISSION_TEST";

async function expectPgReject(
  client: PoolClient,
  savepoint: string,
  sql: string,
  params: readonly unknown[],
  pattern: RegExp,
): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await client.query(sql, [...params]);
    assert.fail(`Expected PostgreSQL statement to fail at savepoint ${savepoint}`);
  } catch (error) {
    assert.match(String(error), pattern);
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  }
}

async function insertAdmissionRevision(input: {
  client: PoolClient;
  sourceDefinitionId: string;
  revisionNumber: number;
  policyVersion: string;
  admissionStatus: "EXPERIMENTAL" | "ADMITTED";
  valueQuestion: string;
  supersedesRevisionId: string | null;
}): Promise<string> {
  const result = await input.client.query<{ id: string }>(
    `INSERT INTO source_admission_revisions(
       source_definition_id, revision_number, policy_version, admission_status,
       value_question, official_access_reference, terms_reference, terms_checked_at,
       review_due_at, license_class, commercial_use_status, redistribution_status,
       raw_retention_status, canonical_retention_status, derived_data_status,
       public_display_status, attribution_requirement, collection_allowed,
       canonical_projection_allowed, measurement_projection_allowed, operator_constraints,
       admission_sha256, supersedes_revision_id, reviewed_at
     ) VALUES (
       $1,$2,$3,$4,$5,NULL,NULL,NULL,NULL,'INTERNAL_TEST','NOT_APPLICABLE','NOT_APPLICABLE',
       'NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE',NULL,
       true,true,true,'Test-only source.',repeat('0',64)::char(64),$6,now()
     ) RETURNING id`,
    [input.sourceDefinitionId, input.revisionNumber, input.policyVersion, input.admissionStatus,
      input.valueQuestion, input.supersedesRevisionId],
  );
  const id = result.rows[0]?.id;
  assert.ok(id);
  return id;
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{ id: string }>(
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
    const sourceDefinitionId = source.rows[0]?.id;
    assert.ok(sourceDefinitionId);
    await client.query("INSERT INTO source_schedule_state(source_definition_id, next_due_at) VALUES ($1, now())", [sourceDefinitionId]);
    await client.query("INSERT INTO source_health(source_definition_id, health_status) VALUES ($1, 'PAUSED')", [sourceDefinitionId]);

    await expectPgReject(client, "no_admission",
      "UPDATE source_definitions SET enabled = true, updated_at = now() WHERE id = $1",
      [sourceDefinitionId], /cannot be enabled without a current admission revision/i);

    const experimentalRevisionId = await insertAdmissionRevision({
      client, sourceDefinitionId, revisionNumber: 1,
      policyVersion: "node5-test-experimental-v1", admissionStatus: "EXPERIMENTAL",
      valueQuestion: "Can the admission gate reject a non-admitted source?", supersedesRevisionId: null,
    });

    await expectPgReject(client, "experimental_admission",
      "UPDATE source_definitions SET enabled = true, updated_at = now() WHERE id = $1",
      [sourceDefinitionId], /cannot be enabled with admission status EXPERIMENTAL/i);

    const admittedRevisionId = await insertAdmissionRevision({
      client, sourceDefinitionId, revisionNumber: 2,
      policyVersion: "node5-test-admitted-v2", admissionStatus: "ADMITTED",
      valueQuestion: "Can an explicitly admitted internal test source pass the gate?",
      supersedesRevisionId: experimentalRevisionId,
    });

    const admission = await client.query<{
      revision_number: number;
      admission_status: string;
      hash_valid: boolean;
      current_revision_id: string;
    }>(
      `SELECT a.revision_number, a.admission_status, a.hash_valid, h.current_revision_id
       FROM current_source_admissions a
       JOIN source_admission_heads h ON h.source_definition_id = a.source_definition_id
       WHERE a.source_definition_id = $1`, [sourceDefinitionId]);
    assert.equal(admission.rows[0]?.revision_number, 2);
    assert.equal(admission.rows[0]?.admission_status, "ADMITTED");
    assert.equal(admission.rows[0]?.hash_valid, true);
    assert.equal(admission.rows[0]?.current_revision_id, admittedRevisionId);

    await client.query("UPDATE source_definitions SET enabled = true, updated_at = now() WHERE id = $1", [sourceDefinitionId]);
    const enabled = await client.query<{ enabled: boolean }>("SELECT enabled FROM source_definitions WHERE id = $1", [sourceDefinitionId]);
    assert.equal(enabled.rows[0]?.enabled, true);

    const scheduleRevision = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM source_schedule_revisions WHERE source_definition_id = $1 AND change_reason = 'SOURCE_ENABLED'",
      [sourceDefinitionId]);
    assert.equal(scheduleRevision.rows[0]?.count, 1);

    await expectPgReject(client, "immutable_policy",
      "UPDATE source_admission_revisions SET value_question = 'tampered' WHERE id = $1",
      [admittedRevisionId], /immutable/i);

    await client.query("UPDATE source_definitions SET enabled = false, updated_at = now() WHERE id = $1", [sourceDefinitionId]);
    await client.query("ROLLBACK");

    const residue = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM source_definitions WHERE source_key = $1", [sourceKey]);
    assert.equal(residue.rows[0]?.count, 0);
    console.log("NODE-5A source admission acceptance passed");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
    throw error;
  } finally {
    client.release();
  }
}

try {
  await main();
} finally {
  await pool.end();
}

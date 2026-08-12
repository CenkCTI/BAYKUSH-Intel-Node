import assert from "node:assert/strict";
import { pool } from "../src/db/pool.js";
import { collectNode2Readiness, PRODUCTION_SOURCE_KEYS, registryContractErrors } from "../src/node2g/readiness.js";

const manifestIds: Readonly<Record<string, string>> = {
  CISA_KEV: "__catalog_manifest__",
  FIRST_EPSS: "dataset-manifest",
  THREATFOX: "query-manifest",
  MALWAREBAZAAR: "query-manifest",
};

async function main(): Promise<void> {
  assert.deepEqual(registryContractErrors(), [], "all five production adapters must satisfy the frozen NODE-2 semantic/admission contract");

  const report = await collectNode2Readiness(pool);
  assert.equal(report.sources.length, PRODUCTION_SOURCE_KEYS.length);
  assert.equal(report.canonicalWithoutRaw, 0, "canonical evidence may never exist without immutable raw provenance");
  assert.equal(report.canonicalSourceMismatches, 0, "canonical evidence must retain the raw record source identity");
  assert.equal(report.duplicateActiveScheduledRuns, 0, "a source may not have duplicate active scheduled/bootstrap runs");

  for (const source of report.sources) {
    assert.equal(source.registered, true, `${source.sourceKey} adapter must be registered`);
    assert.equal(source.definitionPresent, true, `${source.sourceKey} source definition must be synchronized`);
    assert.equal(source.semanticContractMatches, true, `${source.sourceKey} semantic contract must match NODE-2 acceptance`);
    assert.equal(source.sourceAdmissionComplete, true, `${source.sourceKey} source admission metadata must be complete`);
    assert.equal(source.enabledByDefault, false, `${source.sourceKey} must remain disabled by default`);
    assert.ok(source.successfulRuns > 0, `${source.sourceKey} must have passed at least one PostgreSQL-backed collection acceptance`);
    assert.equal(source.checkpointPresent, true, `${source.sourceKey} must have durable checkpoint state after acceptance`);
    assert.ok(source.rawRecords > 0, `${source.sourceKey} must retain immutable raw source truth`);
    assert.ok(source.canonicalRecords > 0, `${source.sourceKey} must produce canonical evidence`);
    assert.equal(source.normalizationQueued, 0, `${source.sourceKey} normalization queue must drain`);
    assert.equal(source.normalizationRunning, 0, `${source.sourceKey} normalization worker must leave no running work`);
    assert.equal(source.normalizationFailed, 0, `${source.sourceKey} must have zero failed normalization jobs`);
    assert.equal(source.provenanceMismatches, 0, `${source.sourceKey} canonical/raw provenance must agree`);
    assert.equal(source.normalizationSourceMismatches, 0, `${source.sourceKey} normalization/raw source identity must agree`);
    assert.equal(source.automatedReady, true, `${source.sourceKey} automated NODE-2 readiness must pass`);
  }
  assert.equal(report.automatedReady, true, "five-source automated NODE-2 readiness must pass before live shadow parity");

  const manifests = await pool.query<{
    source_key: string;
    source_record_id: string;
    state: string;
    canonical_records_written: number;
  }>(
    `SELECT d.source_key, raw.source_record_id, j.state, j.canonical_records_written
       FROM normalization_jobs j
       JOIN raw_source_records raw ON raw.id = j.raw_record_id
       JOIN source_definitions d ON d.id = j.source_definition_id
      WHERE (d.source_key = 'CISA_KEV' AND raw.source_record_id = '__catalog_manifest__')
         OR (d.source_key = 'FIRST_EPSS' AND raw.source_record_id = 'dataset-manifest')
         OR (d.source_key = 'THREATFOX' AND raw.source_record_id = 'query-manifest')
         OR (d.source_key = 'MALWAREBAZAAR' AND raw.source_record_id = 'query-manifest')
      ORDER BY d.source_key, j.created_at DESC`,
  );

  for (const [sourceKey, manifestId] of Object.entries(manifestIds)) {
    const row = manifests.rows.find((candidate) => candidate.source_key === sourceKey && candidate.source_record_id === manifestId);
    assert.ok(row, `${sourceKey} raw provenance manifest must exist`);
    assert.equal(row.state, "SUCCEEDED", `${sourceKey} manifest normalization job must succeed`);
    assert.equal(row.canonical_records_written, 0, `${sourceKey} provenance manifest must not manufacture canonical intelligence`);
  }

  const nvdMirroredCisaFacts = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM canonical_evidence_records c
       JOIN source_definitions d ON d.id = c.source_definition_id,
            jsonb_array_elements(c.facts) fact
      WHERE d.source_key = 'NVD_CVE'
        AND lower(fact ->> 'predicate') LIKE '%cisa%'`,
  );
  assert.equal(nvdMirroredCisaFacts.rows[0]?.count ?? 0, 0, "NVD-mirrored CISA fields must not become independent canonical CISA corroboration");

  const unsafeSemanticPredicates = await pool.query<{ source_key: string; predicate: string }>(
    `SELECT DISTINCT d.source_key, lower(fact ->> 'predicate') AS predicate
       FROM canonical_evidence_records c
       JOIN source_definitions d ON d.id = c.source_definition_id,
            jsonb_array_elements(c.facts) fact
      WHERE d.source_key = ANY($1::text[])
        AND lower(fact ->> 'predicate') ~ '(^|[._-])(baykush_)?(attack_count|victim_count|business_risk|global_threat_level|remediation_priority|attacker_origin|target_country)([._-]|$)'`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );
  assert.deepEqual(unsafeSemanticPredicates.rows, [], "source normalization must not manufacture analytic attack/risk/attribution facts");

  const activeBySource = await pool.query<{ source_key: string; count: number }>(
    `SELECT d.source_key, count(*)::int AS count
       FROM collection_runs r
       JOIN source_definitions d ON d.id = r.source_definition_id
      WHERE d.source_key = ANY($1::text[])
        AND r.state IN ('QUEUED','RUNNING')
        AND r.trigger IN ('SCHEDULED','BOOTSTRAP')
      GROUP BY d.source_key
      HAVING count(*) > 1`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );
  assert.deepEqual(activeBySource.rows, []);

  console.log("NODE-2G five-source automated acceptance passed");
}

try {
  await main();
} finally {
  await pool.end();
}

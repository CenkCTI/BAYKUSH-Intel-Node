import type { Pool } from "pg";
import { adapterRegistry } from "../sources/registry.js";
import type { ProductionSourceKey } from "./parity.js";

export const PRODUCTION_SOURCE_KEYS: readonly ProductionSourceKey[] = [
  "CISA_KEV",
  "NVD_CVE",
  "FIRST_EPSS",
  "THREATFOX",
  "MALWAREBAZAAR",
] as const;

interface ExpectedSemanticContract {
  sourceClass: string;
  observationBasis: string;
}

const expectedSemanticContracts: Readonly<Record<ProductionSourceKey, ExpectedSemanticContract>> = {
  CISA_KEV: { sourceClass: "EXPLOITED_VULNERABILITY_CATALOG", observationBasis: "PUBLISHED" },
  NVD_CVE: { sourceClass: "VULNERABILITY_DATABASE", observationBasis: "ENRICHED" },
  FIRST_EPSS: { sourceClass: "EXPLOIT_PROBABILITY", observationBasis: "SCORED" },
  THREATFOX: { sourceClass: "IOC_SHARING", observationBasis: "REPORTED" },
  MALWAREBAZAAR: { sourceClass: "MALWARE_SAMPLE_REPOSITORY", observationBasis: "PUBLISHED" },
};

export interface SourceReadinessStatus {
  sourceKey: ProductionSourceKey;
  registered: boolean;
  definitionPresent: boolean;
  semanticContractMatches: boolean;
  sourceAdmissionComplete: boolean;
  enabledByDefault: boolean | null;
  enabled: boolean | null;
  healthStatus: string | null;
  successfulRuns: number;
  checkpointPresent: boolean;
  rawRecords: number;
  canonicalRecords: number;
  normalizationQueued: number;
  normalizationRunning: number;
  normalizationFailed: number;
  provenanceMismatches: number;
  normalizationSourceMismatches: number;
  automatedReady: boolean;
}

export interface Node2ReadinessReport {
  generatedAt: string;
  sources: SourceReadinessStatus[];
  canonicalWithoutRaw: number;
  canonicalSourceMismatches: number;
  duplicateActiveScheduledRuns: number;
  automatedReady: boolean;
}

export function registryContractErrors(): string[] {
  const errors: string[] = [];
  for (const sourceKey of PRODUCTION_SOURCE_KEYS) {
    const adapter = adapterRegistry.get(sourceKey);
    if (!adapter) {
      errors.push(`${sourceKey}: adapter is not registered`);
      continue;
    }
    const expected = expectedSemanticContracts[sourceKey];
    const definition = adapter.definition;
    if (definition.sourceClass !== expected.sourceClass) {
      errors.push(`${sourceKey}: sourceClass ${definition.sourceClass} != ${expected.sourceClass}`);
    }
    if (definition.observationBasis !== expected.observationBasis) {
      errors.push(`${sourceKey}: observationBasis ${definition.observationBasis} != ${expected.observationBasis}`);
    }
    if (definition.enabledByDefault) errors.push(`${sourceKey}: production sources must remain disabled by default`);
    if (!definition.semanticBoundary.represents.trim() || !definition.semanticBoundary.doesNotRepresent.trim()) {
      errors.push(`${sourceKey}: semantic boundary is incomplete`);
    }
    if (!definition.licenseClass.trim()) errors.push(`${sourceKey}: licenseClass is empty`);
    if (!definition.termsReference) errors.push(`${sourceKey}: termsReference is missing`);
    if (!definition.semanticContractVersion.trim()) errors.push(`${sourceKey}: semanticContractVersion is empty`);
    if (!adapter.normalizationVersion.trim()) errors.push(`${sourceKey}: normalizationVersion is empty`);
    if (!adapter.checkpointSchemaVersion.trim()) errors.push(`${sourceKey}: checkpointSchemaVersion is empty`);
  }
  return errors;
}

export async function collectNode2Readiness(pool: Pool): Promise<Node2ReadinessReport> {
  const sourceRows = await pool.query<{
    source_key: ProductionSourceKey;
    source_class: string;
    observation_basis: string;
    enabled_by_default: boolean;
    enabled: boolean;
    health_status: string | null;
    successful_runs: number;
    checkpoint_present: boolean;
    raw_records: number;
    canonical_records: number;
    normalization_queued: number;
    normalization_running: number;
    normalization_failed: number;
    provenance_mismatches: number;
    normalization_source_mismatches: number;
    license_class: string;
    terms_reference: string | null;
    represents: string;
    does_not_represent: string;
    semantic_contract_version: string;
  }>(
    `SELECT
       d.source_key,
       d.source_class,
       d.observation_basis,
       d.enabled_by_default,
       d.enabled,
       h.health_status,
       (SELECT count(*)::int FROM collection_runs r WHERE r.source_definition_id = d.id AND r.state = 'SUCCEEDED') AS successful_runs,
       EXISTS (SELECT 1 FROM source_checkpoints cp WHERE cp.source_definition_id = d.id) AS checkpoint_present,
       (SELECT count(*)::int FROM raw_source_records raw WHERE raw.source_definition_id = d.id) AS raw_records,
       (SELECT count(*)::int FROM canonical_evidence_records c WHERE c.source_definition_id = d.id) AS canonical_records,
       (SELECT count(*)::int FROM normalization_jobs j WHERE j.source_definition_id = d.id AND j.state = 'QUEUED') AS normalization_queued,
       (SELECT count(*)::int FROM normalization_jobs j WHERE j.source_definition_id = d.id AND j.state = 'RUNNING') AS normalization_running,
       (SELECT count(*)::int FROM normalization_jobs j WHERE j.source_definition_id = d.id AND j.state = 'FAILED') AS normalization_failed,
       (SELECT count(*)::int FROM canonical_evidence_records c
          JOIN raw_source_records raw ON raw.id = c.raw_record_id
         WHERE c.source_definition_id = d.id
           AND (raw.source_definition_id <> c.source_definition_id OR raw.source_record_id <> c.source_record_id)) AS provenance_mismatches,
       (SELECT count(*)::int FROM normalization_jobs j
          JOIN raw_source_records raw ON raw.id = j.raw_record_id
         WHERE j.source_definition_id = d.id AND raw.source_definition_id <> j.source_definition_id) AS normalization_source_mismatches,
       d.license_class,
       d.terms_reference,
       d.represents,
       d.does_not_represent,
       d.semantic_contract_version
     FROM source_definitions d
     LEFT JOIN source_health h ON h.source_definition_id = d.id
     WHERE d.source_key = ANY($1::text[])
     ORDER BY array_position($1::text[], d.source_key)`,
    [[...PRODUCTION_SOURCE_KEYS]],
  );

  const byKey = new Map(sourceRows.rows.map((row) => [row.source_key, row]));
  const registryErrors = registryContractErrors();
  const sources: SourceReadinessStatus[] = PRODUCTION_SOURCE_KEYS.map((sourceKey) => {
    const row = byKey.get(sourceKey);
    const registered = adapterRegistry.has(sourceKey);
    const definitionPresent = row !== undefined;
    const expected = expectedSemanticContracts[sourceKey];
    const semanticContractMatches = Boolean(row && row.source_class === expected.sourceClass && row.observation_basis === expected.observationBasis);
    const sourceAdmissionComplete = Boolean(
      row && row.license_class.trim() && row.terms_reference && row.represents.trim() && row.does_not_represent.trim() && row.semantic_contract_version.trim(),
    );
    const automatedReady = Boolean(
      registered &&
      definitionPresent &&
      semanticContractMatches &&
      sourceAdmissionComplete &&
      row?.enabled_by_default === false &&
      (row?.successful_runs ?? 0) > 0 &&
      row?.checkpoint_present &&
      (row?.raw_records ?? 0) > 0 &&
      (row?.normalization_queued ?? 0) === 0 &&
      (row?.normalization_running ?? 0) === 0 &&
      (row?.normalization_failed ?? 0) === 0 &&
      (row?.provenance_mismatches ?? 0) === 0 &&
      (row?.normalization_source_mismatches ?? 0) === 0 &&
      !registryErrors.some((error) => error.startsWith(`${sourceKey}:`)),
    );
    return {
      sourceKey,
      registered,
      definitionPresent,
      semanticContractMatches,
      sourceAdmissionComplete,
      enabledByDefault: row?.enabled_by_default ?? null,
      enabled: row?.enabled ?? null,
      healthStatus: row?.health_status ?? null,
      successfulRuns: row?.successful_runs ?? 0,
      checkpointPresent: row?.checkpoint_present ?? false,
      rawRecords: row?.raw_records ?? 0,
      canonicalRecords: row?.canonical_records ?? 0,
      normalizationQueued: row?.normalization_queued ?? 0,
      normalizationRunning: row?.normalization_running ?? 0,
      normalizationFailed: row?.normalization_failed ?? 0,
      provenanceMismatches: row?.provenance_mismatches ?? 0,
      normalizationSourceMismatches: row?.normalization_source_mismatches ?? 0,
      automatedReady,
    };
  });

  const global = await pool.query<{
    canonical_without_raw: number;
    canonical_source_mismatches: number;
    duplicate_active_scheduled_runs: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM canonical_evidence_records c LEFT JOIN raw_source_records raw ON raw.id = c.raw_record_id WHERE raw.id IS NULL) AS canonical_without_raw,
       (SELECT count(*)::int FROM canonical_evidence_records c JOIN raw_source_records raw ON raw.id = c.raw_record_id WHERE c.source_definition_id <> raw.source_definition_id) AS canonical_source_mismatches,
       (SELECT count(*)::int FROM (
          SELECT source_definition_id FROM collection_runs
          WHERE state IN ('QUEUED','RUNNING') AND trigger IN ('SCHEDULED','BOOTSTRAP')
          GROUP BY source_definition_id HAVING count(*) > 1
        ) duplicates) AS duplicate_active_scheduled_runs`,
  );
  const globalRow = global.rows[0];
  const canonicalWithoutRaw = globalRow?.canonical_without_raw ?? 0;
  const canonicalSourceMismatches = globalRow?.canonical_source_mismatches ?? 0;
  const duplicateActiveScheduledRuns = globalRow?.duplicate_active_scheduled_runs ?? 0;

  return {
    generatedAt: new Date().toISOString(),
    sources,
    canonicalWithoutRaw,
    canonicalSourceMismatches,
    duplicateActiveScheduledRuns,
    automatedReady:
      sources.every((source) => source.automatedReady) &&
      canonicalWithoutRaw === 0 &&
      canonicalSourceMismatches === 0 &&
      duplicateActiveScheduledRuns === 0 &&
      registryErrors.length === 0,
  };
}

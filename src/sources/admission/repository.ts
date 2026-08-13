import { pool, withTransaction } from "../../db/pool.js";
import { canonicalJsonStringify } from "../../runtime/raw-record.js";
import type { AdmissionPolicyDefinition, CurrentSourceAdmission } from "./contracts.js";
import { currentSourceAdmissionSchema } from "./contracts.js";
import { assertAdmissionPolicyDefinition, comparableAdmissionPolicy, validateAdmissionForEnable } from "./policy.js";

interface CurrentAdmissionRow {
  source_key: string;
  display_name: string;
  enabled: boolean;
  revision_id: string | null;
  revision_number: number | null;
  policy_version: string | null;
  admission_status: string | null;
  value_question: string | null;
  official_access_reference: string | null;
  terms_reference: string | null;
  terms_checked_at: Date | null;
  review_due_at: Date | null;
  license_class: string | null;
  commercial_use_status: string | null;
  redistribution_status: string | null;
  raw_retention_status: string | null;
  canonical_retention_status: string | null;
  derived_data_status: string | null;
  public_display_status: string | null;
  attribution_requirement: string | null;
  collection_allowed: boolean | null;
  canonical_projection_allowed: boolean | null;
  measurement_projection_allowed: boolean | null;
  operator_constraints: string | null;
  admission_sha256: string | null;
  reviewed_at: Date | null;
  created_at: Date | null;
  hash_valid: boolean | null;
}

const CURRENT_ADMISSION_SELECT = `
  SELECT source_key, display_name, enabled, revision_id, revision_number, policy_version,
         admission_status, value_question, official_access_reference, terms_reference,
         terms_checked_at, review_due_at, license_class, commercial_use_status,
         redistribution_status, raw_retention_status, canonical_retention_status,
         derived_data_status, public_display_status, attribution_requirement,
         collection_allowed, canonical_projection_allowed, measurement_projection_allowed,
         operator_constraints, admission_sha256, reviewed_at, created_at, hash_valid
  FROM current_source_admissions`;

function mapCurrentAdmission(row: CurrentAdmissionRow): CurrentSourceAdmission | null {
  if (!row.revision_id || row.revision_number === null || !row.policy_version || !row.admission_status || !row.value_question
      || !row.license_class || !row.commercial_use_status || !row.redistribution_status || !row.raw_retention_status
      || !row.canonical_retention_status || !row.derived_data_status || !row.public_display_status
      || row.collection_allowed === null || row.canonical_projection_allowed === null
      || row.measurement_projection_allowed === null || !row.admission_sha256 || !row.reviewed_at || !row.created_at
      || row.hash_valid === null) return null;

  return currentSourceAdmissionSchema.parse({
    sourceKey: row.source_key,
    displayName: row.display_name,
    enabled: row.enabled,
    revisionId: row.revision_id,
    revisionNumber: row.revision_number,
    policyVersion: row.policy_version,
    admissionStatus: row.admission_status,
    valueQuestion: row.value_question,
    officialAccessReference: row.official_access_reference,
    termsReference: row.terms_reference,
    termsCheckedAt: row.terms_checked_at?.toISOString() ?? null,
    reviewDueAt: row.review_due_at?.toISOString() ?? null,
    licenseClass: row.license_class,
    commercialUseStatus: row.commercial_use_status,
    redistributionStatus: row.redistribution_status,
    rawRetentionStatus: row.raw_retention_status,
    canonicalRetentionStatus: row.canonical_retention_status,
    derivedDataStatus: row.derived_data_status,
    publicDisplayStatus: row.public_display_status,
    attributionRequirement: row.attribution_requirement,
    collectionAllowed: row.collection_allowed,
    canonicalProjectionAllowed: row.canonical_projection_allowed,
    measurementProjectionAllowed: row.measurement_projection_allowed,
    operatorConstraints: row.operator_constraints,
    admissionSha256: row.admission_sha256.trim(),
    hashValid: row.hash_valid,
    reviewedAt: row.reviewed_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  });
}

export async function getCurrentSourceAdmission(sourceKey: string): Promise<CurrentSourceAdmission | null> {
  const result = await pool.query<CurrentAdmissionRow>(`${CURRENT_ADMISSION_SELECT} WHERE source_key = $1`, [sourceKey]);
  const row = result.rows[0];
  return row ? mapCurrentAdmission(row) : null;
}

export async function listCurrentSourceAdmissions(): Promise<Array<{
  sourceKey: string;
  displayName: string;
  enabled: boolean;
  admissionStatus: string | null;
  policyVersion: string | null;
  revisionNumber: number | null;
  hashValid: boolean | null;
  reviewDueAt: string | null;
}>> {
  const result = await pool.query<CurrentAdmissionRow>(`${CURRENT_ADMISSION_SELECT} ORDER BY source_key`);
  return result.rows.map((row) => ({
    sourceKey: row.source_key,
    displayName: row.display_name,
    enabled: row.enabled,
    admissionStatus: row.admission_status,
    policyVersion: row.policy_version,
    revisionNumber: row.revision_number,
    hashValid: row.hash_valid,
    reviewDueAt: row.review_due_at?.toISOString() ?? null,
  }));
}

function currentAsPolicy(current: CurrentSourceAdmission): AdmissionPolicyDefinition {
  return {
    sourceKey: current.sourceKey,
    policyVersion: current.policyVersion,
    admissionStatus: current.admissionStatus,
    valueQuestion: current.valueQuestion,
    officialAccessReference: current.officialAccessReference,
    termsReference: current.termsReference,
    termsCheckedAt: current.termsCheckedAt,
    reviewDueAt: current.reviewDueAt,
    licenseClass: current.licenseClass,
    commercialUseStatus: current.commercialUseStatus,
    redistributionStatus: current.redistributionStatus,
    rawRetentionStatus: current.rawRetentionStatus,
    canonicalRetentionStatus: current.canonicalRetentionStatus,
    derivedDataStatus: current.derivedDataStatus,
    publicDisplayStatus: current.publicDisplayStatus,
    attributionRequirement: current.attributionRequirement,
    collectionAllowed: current.collectionAllowed,
    canonicalProjectionAllowed: current.canonicalProjectionAllowed,
    measurementProjectionAllowed: current.measurementProjectionAllowed,
    operatorConstraints: current.operatorConstraints,
    reviewedAt: current.reviewedAt,
  };
}

export async function syncAdmissionPolicy(input: AdmissionPolicyDefinition): Promise<void> {
  const policy = assertAdmissionPolicyDefinition(input);
  const source = await pool.query<{ id: string }>("SELECT id FROM source_definitions WHERE source_key = $1", [policy.sourceKey]);
  const sourceDefinitionId = source.rows[0]?.id;
  if (!sourceDefinitionId) throw new Error(`Admission policy references an unregistered source: ${policy.sourceKey}`);

  const current = await getCurrentSourceAdmission(policy.sourceKey);
  if (current?.policyVersion === policy.policyVersion) {
    const expected = canonicalJsonStringify(comparableAdmissionPolicy(policy));
    const actual = canonicalJsonStringify(comparableAdmissionPolicy(currentAsPolicy(current)));
    if (expected !== actual) throw new Error(`Admission policy ${policy.sourceKey}/${policy.policyVersion} changed without a policy version bump`);
    return;
  }

  await withTransaction(async (client) => {
    const head = await client.query<{ revision_id: string; revision_number: number }>(
      `SELECT r.id AS revision_id, r.revision_number
       FROM source_admission_heads h
       JOIN source_admission_revisions r ON r.id = h.current_revision_id
       WHERE h.source_definition_id = $1
       FOR UPDATE OF h`,
      [sourceDefinitionId],
    );
    const currentHead = head.rows[0];
    const nextRevision = (currentHead?.revision_number ?? 0) + 1;
    await client.query(
      `INSERT INTO source_admission_revisions(
         source_definition_id, revision_number, policy_version, admission_status,
         value_question, official_access_reference, terms_reference, terms_checked_at,
         review_due_at, license_class, commercial_use_status, redistribution_status,
         raw_retention_status, canonical_retention_status, derived_data_status,
         public_display_status, attribution_requirement, collection_allowed,
         canonical_projection_allowed, measurement_projection_allowed, operator_constraints,
         admission_sha256, supersedes_revision_id, reviewed_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
         repeat('0',64)::char(64),$22,$23
       )`,
      [sourceDefinitionId, nextRevision, policy.policyVersion, policy.admissionStatus,
        policy.valueQuestion, policy.officialAccessReference, policy.termsReference, policy.termsCheckedAt,
        policy.reviewDueAt, policy.licenseClass, policy.commercialUseStatus, policy.redistributionStatus,
        policy.rawRetentionStatus, policy.canonicalRetentionStatus, policy.derivedDataStatus,
        policy.publicDisplayStatus, policy.attributionRequirement, policy.collectionAllowed,
        policy.canonicalProjectionAllowed, policy.measurementProjectionAllowed, policy.operatorConstraints,
        currentHead?.revision_id ?? null, policy.reviewedAt],
    );
  });
}

export async function syncAdmissionPolicies(policies: readonly AdmissionPolicyDefinition[]): Promise<void> {
  for (const policy of policies) await syncAdmissionPolicy(policy);
}

export async function assertSourceEnableAllowed(sourceKey: string, now = new Date()): Promise<void> {
  const admission = await getCurrentSourceAdmission(sourceKey);
  const result = validateAdmissionForEnable(admission, now);
  if (!result.allowed) throw new Error(`Source ${sourceKey} cannot be enabled: ${result.blockers.join(", ")}`);
}

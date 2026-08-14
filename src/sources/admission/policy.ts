import type {
  AdmissionPolicyDefinition,
  AdmissionValidationResult,
  CurrentSourceAdmission,
  SourceUseStatus,
} from "./contracts.js";
import { admissionPolicyDefinitionSchema } from "./contracts.js";

const RETENTION_ALLOWED = new Set<SourceUseStatus>(["ALLOWED", "RESTRICTED", "NOT_APPLICABLE"]);
const ENABLEABLE_STATUSES = new Set(["ADMITTED", "ACTIVE"] as const);

export function assertAdmissionPolicyDefinition(input: unknown): AdmissionPolicyDefinition {
  const policy = admissionPolicyDefinitionSchema.parse(input);
  if (policy.reviewDueAt && policy.termsCheckedAt) {
    if (new Date(policy.reviewDueAt).getTime() < new Date(policy.termsCheckedAt).getTime()) {
      throw new Error(`Admission reviewDueAt precedes termsCheckedAt for ${policy.sourceKey}`);
    }
  }
  if (policy.collectionAllowed && !RETENTION_ALLOWED.has(policy.rawRetentionStatus)) {
    throw new Error(`Collection cannot be allowed with rawRetentionStatus=${policy.rawRetentionStatus}`);
  }
  if (policy.canonicalProjectionAllowed && !RETENTION_ALLOWED.has(policy.canonicalRetentionStatus)) {
    throw new Error(`Canonical projection cannot be allowed with canonicalRetentionStatus=${policy.canonicalRetentionStatus}`);
  }
  if (policy.measurementProjectionAllowed && !RETENTION_ALLOWED.has(policy.derivedDataStatus)) {
    throw new Error(`Measurement projection cannot be allowed with derivedDataStatus=${policy.derivedDataStatus}`);
  }
  return policy;
}

export function validateAdmissionForEnable(
  admission: CurrentSourceAdmission | null,
  now = new Date(),
): AdmissionValidationResult {
  const blockers: string[] = [];
  if (!admission) {
    return { allowed: false, blockers: ["NO_CURRENT_ADMISSION"] };
  }
  if (!ENABLEABLE_STATUSES.has(admission.admissionStatus as "ADMITTED" | "ACTIVE")) {
    blockers.push(`STATUS_${admission.admissionStatus}`);
  }
  if (!admission.hashValid) blockers.push("POLICY_HASH_INVALID");
  if (!admission.collectionAllowed) blockers.push("COLLECTION_NOT_ALLOWED");
  if (!RETENTION_ALLOWED.has(admission.rawRetentionStatus)) blockers.push(`RAW_RETENTION_${admission.rawRetentionStatus}`);
  if (!admission.canonicalProjectionAllowed) blockers.push("CANONICAL_PROJECTION_NOT_ALLOWED");
  if (!RETENTION_ALLOWED.has(admission.canonicalRetentionStatus)) {
    blockers.push(`CANONICAL_RETENTION_${admission.canonicalRetentionStatus}`);
  }
  if (admission.licenseClass !== "INTERNAL_TEST" && !admission.termsCheckedAt) blockers.push("TERMS_NOT_CHECKED");
  if (admission.reviewDueAt && new Date(admission.reviewDueAt).getTime() < now.getTime()) blockers.push("ADMISSION_REVIEW_OVERDUE");
  return { allowed: blockers.length === 0, blockers };
}

export function comparableAdmissionPolicy(policy: AdmissionPolicyDefinition): Record<string, unknown> {
  return {
    sourceKey: policy.sourceKey,
    policyVersion: policy.policyVersion,
    admissionStatus: policy.admissionStatus,
    valueQuestion: policy.valueQuestion,
    officialAccessReference: policy.officialAccessReference,
    termsReference: policy.termsReference,
    termsCheckedAt: policy.termsCheckedAt,
    reviewDueAt: policy.reviewDueAt,
    licenseClass: policy.licenseClass,
    commercialUseStatus: policy.commercialUseStatus,
    redistributionStatus: policy.redistributionStatus,
    rawRetentionStatus: policy.rawRetentionStatus,
    canonicalRetentionStatus: policy.canonicalRetentionStatus,
    derivedDataStatus: policy.derivedDataStatus,
    publicDisplayStatus: policy.publicDisplayStatus,
    attributionRequirement: policy.attributionRequirement,
    collectionAllowed: policy.collectionAllowed,
    canonicalProjectionAllowed: policy.canonicalProjectionAllowed,
    measurementProjectionAllowed: policy.measurementProjectionAllowed,
    operatorConstraints: policy.operatorConstraints,
    reviewedAt: policy.reviewedAt,
  };
}

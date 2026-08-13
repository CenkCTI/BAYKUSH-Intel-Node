import { z } from "zod";

export const admissionStatusSchema = z.enum([
  "CANDIDATE",
  "RESEARCHED",
  "EXPERIMENTAL",
  "ADMITTED",
  "ACTIVE",
  "PAUSED",
  "REJECTED",
  "RETIRED",
]);
export type AdmissionStatus = z.infer<typeof admissionStatusSchema>;

export const sourceUseStatusSchema = z.enum([
  "UNKNOWN",
  "ALLOWED",
  "RESTRICTED",
  "PROHIBITED",
  "NOT_APPLICABLE",
]);
export type SourceUseStatus = z.infer<typeof sourceUseStatusSchema>;

const optionalUrlSchema = z.string().url().nullable();
const optionalTimestampSchema = z.string().datetime({ offset: true }).nullable();

export const admissionPolicyDefinitionSchema = z.object({
  sourceKey: z.string().regex(/^[A-Z0-9_]+$/).max(128),
  policyVersion: z.string().min(1).max(128),
  admissionStatus: admissionStatusSchema,
  valueQuestion: z.string().min(1).max(4_000),
  officialAccessReference: optionalUrlSchema,
  termsReference: optionalUrlSchema,
  termsCheckedAt: optionalTimestampSchema,
  reviewDueAt: optionalTimestampSchema,
  licenseClass: z.string().min(1).max(128),
  commercialUseStatus: sourceUseStatusSchema,
  redistributionStatus: sourceUseStatusSchema,
  rawRetentionStatus: sourceUseStatusSchema,
  canonicalRetentionStatus: sourceUseStatusSchema,
  derivedDataStatus: sourceUseStatusSchema,
  publicDisplayStatus: sourceUseStatusSchema,
  attributionRequirement: z.string().max(4_000).nullable(),
  collectionAllowed: z.boolean(),
  canonicalProjectionAllowed: z.boolean(),
  measurementProjectionAllowed: z.boolean(),
  operatorConstraints: z.string().max(8_000).nullable(),
  reviewedAt: z.string().datetime({ offset: true }),
});
export type AdmissionPolicyDefinition = z.infer<typeof admissionPolicyDefinitionSchema>;

export const currentSourceAdmissionSchema = admissionPolicyDefinitionSchema.omit({ sourceKey: true }).extend({
  sourceKey: z.string().regex(/^[A-Z0-9_]+$/).max(128),
  displayName: z.string().min(1),
  enabled: z.boolean(),
  revisionId: z.string().uuid(),
  revisionNumber: z.number().int().positive(),
  admissionSha256: z.string().regex(/^[a-f0-9]{64}$/),
  hashValid: z.boolean(),
  createdAt: z.string().datetime({ offset: true }),
});
export type CurrentSourceAdmission = z.infer<typeof currentSourceAdmissionSchema>;

export interface AdmissionValidationResult {
  allowed: boolean;
  blockers: readonly string[];
}

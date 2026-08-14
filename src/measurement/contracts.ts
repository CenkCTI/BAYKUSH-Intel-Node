import { z } from "zod";

export const measurementDomainSchema = z.enum([
  "VULNERABILITY",
  "EXPLOITATION_CONTEXT",
  "IOC_REPORTING",
  "MALWARE_REPORTING",
  "SOURCE_HEALTH",
  "INTERNET_ROUTING",
  "INTERNAL_TEST",
]);
export type MeasurementDomain = z.infer<typeof measurementDomainSchema>;

export const measurementTimeAxisSchema = z.enum([
  "SOURCE_EFFECTIVE_TIME",
  "SOURCE_PUBLISHED_TIME",
  "UPSTREAM_UPDATED_TIME",
  "NODE_RECEIVED_TIME",
  "SOURCE_DATASET_DATE",
  "SOURCE_OBSERVED_TIME",
]);
export type MeasurementTimeAxis = z.infer<typeof measurementTimeAxisSchema>;

export const measurementTimePrecisionSchema = z.enum(["INSTANT", "DATE"]);
export type MeasurementTimePrecision = z.infer<typeof measurementTimePrecisionSchema>;

export const measurementGranularitySchema = z.enum(["ONE_MINUTE", "FIVE_MINUTES", "HOUR", "DAY"]);
export type MeasurementGranularity = z.infer<typeof measurementGranularitySchema>;

export const measurementValueKindSchema = z.enum(["COUNT", "GAUGE", "DISTRIBUTION"]);
export type MeasurementValueKind = z.infer<typeof measurementValueKindSchema>;

export const measurementAggregationKindSchema = z.enum([
  "COUNT_EVENTS",
  "COUNT_DISTINCT",
  "FIRST_SEEN_DISTINCT",
  "SNAPSHOT_LAST",
  "SNAPSHOT_LAST_CARRY_FORWARD",
  "DATASET_COUNT",
  "DISTRIBUTION_COUNT",
]);
export type MeasurementAggregationKind = z.infer<typeof measurementAggregationKindSchema>;

export const measurementAcquisitionPolicySchema = z.enum([
  "SOURCE_TIME_RECONCILABLE",
  "OBSERVATION_TIME_LIVE_ONLY",
  "SNAPSHOT_STATE",
  "DATASET_SNAPSHOT",
]);
export type MeasurementAcquisitionPolicy = z.infer<typeof measurementAcquisitionPolicySchema>;

export const measurementCoveragePolicySchema = z.enum([
  "SOURCE_COVERAGE_REQUIRED",
  "SOURCE_TIME_AVAILABILITY_REQUIRED",
  "SNAPSHOT_CONFIRMATION_REQUIRED",
  "DATASET_AVAILABILITY_REQUIRED",
]);
export type MeasurementCoveragePolicy = z.infer<typeof measurementCoveragePolicySchema>;

export const measurementZeroPolicySchema = z.enum(["ZERO_REQUIRES_VALID_COVERAGE"]);
export type MeasurementZeroPolicy = z.infer<typeof measurementZeroPolicySchema>;

export const measurementComparisonKindSchema = z.enum([
  "SUM_EVENTS",
  "LAST_VALUE",
  "EXACT_DISTINCT_QUERY",
  "NONE",
]);
export type MeasurementComparisonKind = z.infer<typeof measurementComparisonKindSchema>;

export const measurementChangeFeedPolicySchema = z.enum(["NONE", "FACT", "BUCKET_SUMMARY"]);
export type MeasurementChangeFeedPolicy = z.infer<typeof measurementChangeFeedPolicySchema>;

export const measurementVisibilitySchema = z.enum(["PUBLIC", "INTERNAL"]);
export type MeasurementVisibility = z.infer<typeof measurementVisibilitySchema>;

export const dimensionDefinitionSchema = z.object({
  key: z.string().regex(/^[A-Z0-9_]+$/).max(128),
  topN: z.number().int().min(1).max(50).nullable().default(null),
  includeOther: z.boolean().default(false),
}).strict();
export type MeasurementDimensionDefinition = z.infer<typeof dimensionDefinitionSchema>;

export const comparisonPolicySchema = z.object({
  kind: measurementComparisonKindSchema,
  requireCompleteCoverage: z.boolean().default(true),
  requireSamePopulationProfile: z.boolean().default(false),
  requireSameSourceModelVersion: z.boolean().default(false),
}).strict();
export type MeasurementComparisonPolicy = z.infer<typeof comparisonPolicySchema>;

export const measurementDefinitionSchema = z.object({
  measurementKey: z.string().regex(/^[a-z0-9_.]+$/).min(3).max(256),
  contractVersion: z.string().regex(/^v[0-9]+$/).max(32),
  domain: measurementDomainSchema,
  displayLabel: z.string().min(1).max(256),
  description: z.string().min(1).max(2_000),
  unit: z.string().regex(/^[A-Z0-9_]+$/).max(128),
  valueKind: measurementValueKindSchema,
  primaryTimeAxis: measurementTimeAxisSchema,
  timePrecision: measurementTimePrecisionSchema,
  sourceKeys: z.array(z.string().regex(/^[A-Z0-9_]+$/).max(128)).min(1).max(16),
  recordKinds: z.array(z.string().regex(/^[A-Z0-9_]+$/).max(128)).max(32),
  supportedGranularities: z.array(measurementGranularitySchema).min(1).max(4),
  supportedDimensions: z.array(dimensionDefinitionSchema).max(16),
  coveragePolicy: measurementCoveragePolicySchema,
  zeroPolicy: measurementZeroPolicySchema,
  acquisitionPolicy: measurementAcquisitionPolicySchema,
  comparisonPolicy: comparisonPolicySchema,
  populationProfile: z.record(z.string(), z.unknown()).nullable().default(null),
  changeFeedPolicy: measurementChangeFeedPolicySchema,
  visibility: measurementVisibilitySchema,
  represents: z.string().min(1).max(4_000),
  doesNotRepresent: z.string().min(1).max(4_000),
}).strict().superRefine((definition, ctx) => {
  if (definition.timePrecision === "DATE" && definition.supportedGranularities.some((value) => value !== "DAY")) {
    ctx.addIssue({ code: "custom", message: "DATE precision measurements may only expose DAY granularity" });
  }
  if (definition.valueKind === "DISTRIBUTION" && definition.supportedDimensions.length === 0) {
    ctx.addIssue({ code: "custom", message: "DISTRIBUTION measurements require at least one supported dimension" });
  }
});
export type MeasurementDefinition = z.infer<typeof measurementDefinitionSchema>;

export const measurementCalculationSchema = z.object({
  calculationVersion: z.string().regex(/^v[0-9]+$/).max(32),
  projectorKey: z.string().regex(/^[A-Z0-9_]+$/).max(128),
  aggregationKind: measurementAggregationKindSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type MeasurementCalculation = z.infer<typeof measurementCalculationSchema>;

export const measurementRegistrationSchema = z.object({
  definition: measurementDefinitionSchema,
  calculation: measurementCalculationSchema,
}).strict();
export type MeasurementRegistration = z.infer<typeof measurementRegistrationSchema>;

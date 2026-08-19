import { z } from "zod";

export const Node7FindingTypeSchema = z.enum([
  "SOURCE_SYSTEM_OVERLAP",
  "MULTI_ORIGIN_CONVERGENCE",
  "CROSS_CLASS_CONVERGENCE",
  "CONCURRENT_MOVEMENT",
  "COMPOSITION_EXPANSION",
  "NEW_ENTITY",
  "HISTORICAL_DISCOVERY",
]);
export type Node7FindingType = z.infer<typeof Node7FindingTypeSchema>;

export const Node7GeoClassSchema = z.enum([
  "OBSERVED_INFRASTRUCTURE_LOCATION",
  "REPORTED_TARGET",
  "REPORTED_ACTIVITY",
]);
export type Node7GeoClass = z.infer<typeof Node7GeoClassSchema>;

export const Node7TimePrecisionSchema = z.enum(["INSTANT", "DATE"]);
export type Node7TimePrecision = z.infer<typeof Node7TimePrecisionSchema>;

export const Node7DerivationPolicyKindSchema = z.enum([
  "CONVERGENCE",
  "DISCOVERY",
  "GEOGRAPHY",
  "ROUTING_CONTEXT",
]);

export const Node7AcquisitionBasisSchema = z.enum([
  "LIVE_INCREMENTAL",
  "INITIAL_BOOTSTRAP",
  "RECOVERY",
  "HISTORICAL_BACKFILL",
  "RESYNC",
  "REPAIR",
  "SNAPSHOT_RECONSTRUCTION",
]);
export type Node7AcquisitionBasis = z.infer<typeof Node7AcquisitionBasisSchema>;

export const Node7ConvergenceInputSchema = z.object({
  sourceDefinitionCount: z.number().int().nonnegative(),
  upstreamOriginCount: z.number().int().nonnegative(),
  sourceClassCount: z.number().int().nonnegative(),
  timePrecision: Node7TimePrecisionSchema,
  observationSpanSeconds: z.number().int().nonnegative().nullable(),
  concurrentWindowSeconds: z.number().int().positive(),
});

export interface Node7ConvergenceClassification {
  findingTypes: Node7FindingType[];
  concurrentEligible: boolean;
}

export function classifyNode7Convergence(
  input: z.infer<typeof Node7ConvergenceInputSchema>,
): Node7ConvergenceClassification {
  const parsed = Node7ConvergenceInputSchema.parse(input);
  const findingTypes: Node7FindingType[] = [];

  if (parsed.sourceDefinitionCount >= 2) {
    findingTypes.push("SOURCE_SYSTEM_OVERLAP");
  }
  if (parsed.upstreamOriginCount >= 2) {
    findingTypes.push("MULTI_ORIGIN_CONVERGENCE");
  }
  if (parsed.sourceClassCount >= 2) {
    findingTypes.push("CROSS_CLASS_CONVERGENCE");
  }

  const concurrentEligible = parsed.timePrecision === "INSTANT"
    && parsed.upstreamOriginCount >= 2
    && parsed.observationSpanSeconds !== null
    && parsed.observationSpanSeconds <= parsed.concurrentWindowSeconds;
  if (concurrentEligible) findingTypes.push("CONCURRENT_MOVEMENT");

  return { findingTypes, concurrentEligible };
}

const HISTORICAL_ONLY_BASES = new Set<Node7AcquisitionBasis>([
  "INITIAL_BOOTSTRAP",
  "RECOVERY",
  "HISTORICAL_BACKFILL",
  "SNAPSHOT_RECONSTRUCTION",
]);

export function classifyNode7NoveltyBasis(
  basis: Node7AcquisitionBasis,
): "CURRENT" | "HISTORICAL" {
  return HISTORICAL_ONLY_BASES.has(basis) ? "HISTORICAL" : "CURRENT";
}

export function exactCanonicalSubject(entityType: string, entityKey: string): string {
  const type = entityType.trim();
  const key = entityKey.trim();
  if (!type || !key) throw new Error("NODE-7 exact canonical subject requires entity type and key");
  return `${type}\u0000${key}`;
}

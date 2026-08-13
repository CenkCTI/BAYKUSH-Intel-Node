import type { MeasurementDimensionDefinition } from "../contracts.js";

export interface AggregateFact {
  numericValue: number | null;
  entityKey: string | null;
  dimensions: Readonly<Record<string, unknown>>;
}

export interface DistributionValue {
  dimensionKey: string;
  dimensionValue: string;
  count: number;
  share: number | null;
  rank: number;
  isOther: boolean;
}

export function computeAggregateValue(kind: string, facts: readonly AggregateFact[]): number {
  if (kind === "COUNT_EVENTS") return facts.length;
  if (kind === "COUNT_DISTINCT" || kind === "FIRST_SEEN_DISTINCT") {
    return new Set(facts.map((fact) => fact.entityKey).filter((value): value is string => value !== null)).size;
  }
  if (kind === "SNAPSHOT_LAST" || kind === "SNAPSHOT_LAST_CARRY_FORWARD" || kind === "DATASET_COUNT") {
    return facts[facts.length - 1]?.numericValue ?? 0;
  }
  if (kind === "DISTRIBUTION_COUNT") return facts.length;
  throw new Error(`Unsupported aggregation kind ${kind}`);
}

function members(value: unknown): string[] {
  if (typeof value === "string") return value.split("|").map((item) => item.trim()).filter(Boolean);
  if (typeof value === "number" || typeof value === "boolean") return [String(value)];
  return [];
}

export function computeDistributionValues(dimensions: readonly MeasurementDimensionDefinition[], facts: readonly AggregateFact[]): DistributionValue[] {
  const output: DistributionValue[] = [];
  for (const dimension of dimensions) {
    const counts = new Map<string, number>();
    for (const fact of facts) {
      for (const member of members(fact.dimensions[dimension.key])) counts.set(member, (counts.get(member) ?? 0) + 1);
    }
    const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
    const topN = dimension.topN ?? ordered.length;
    const selected = ordered.slice(0, topN);
    const remainder = ordered.slice(topN);
    if (dimension.includeOther && remainder.length > 0) selected.push(["OTHER", remainder.reduce((sum, item) => sum + item[1], 0)]);
    const total = selected.reduce((sum, item) => sum + item[1], 0);
    selected.forEach(([dimensionValue, count], index) => output.push({ dimensionKey: dimension.key, dimensionValue, count, share: total === 0 ? null : count / total, rank: index + 1, isOther: dimensionValue === "OTHER" }));
  }
  return output;
}

export function validZeroAllowed(input: { coveragePolicy: string; liveCoverage: string; dataAvailability: string }): boolean {
  if (input.coveragePolicy === "SOURCE_COVERAGE_REQUIRED" || input.coveragePolicy === "SNAPSHOT_CONFIRMATION_REQUIRED") return input.liveCoverage === "COMPLETE";
  return input.dataAvailability === "AVAILABLE";
}

export function numericValueAllowed(input: { coveragePolicy: string; liveCoverage: string; dataAvailability: string }): boolean {
  if (input.coveragePolicy === "SOURCE_COVERAGE_REQUIRED" || input.coveragePolicy === "SNAPSHOT_CONFIRMATION_REQUIRED") {
    return input.liveCoverage !== "NO_COVERAGE";
  }
  return input.dataAvailability === "AVAILABLE" || input.dataAvailability === "PARTIAL";
}

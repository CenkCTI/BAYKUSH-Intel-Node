function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const source = process.env[name];
  if (source === undefined || source.trim() === "") return fallback;
  const value = Number(source);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}
function booleanEnv(name: string, fallback: boolean): boolean {
  const source = process.env[name];
  if (source === undefined || source.trim() === "") return fallback;
  if (source === "true") return true;
  if (source === "false") return false;
  throw new Error(`${name} must be true or false`);
}
export const measurementConfig = Object.freeze({
  enabled: booleanEnv("MEASUREMENT_ENABLED", true),
  tickMs: integerEnv("MEASUREMENT_TICK_MS", 1_000, 100, 60_000),
  discoveryBatch: integerEnv("MEASUREMENT_DISCOVERY_BATCH", 500, 1, 5_000),
  projectionBatch: integerEnv("MEASUREMENT_PROJECTION_BATCH", 250, 1, 1_000),
  coverageBatch: integerEnv("MEASUREMENT_COVERAGE_BATCH", 100, 1, 1_000),
  aggregationBatch: integerEnv("MEASUREMENT_AGGREGATION_BATCH", 100, 1, 1_000),
  noveltyBatch: integerEnv("MEASUREMENT_NOVELTY_BATCH", 100, 1, 1_000),
  leaseSeconds: integerEnv("MEASUREMENT_LEASE_SECONDS", 60, 10, 3_600),
  maxAttempts: integerEnv("MEASUREMENT_MAX_ATTEMPTS", 5, 1, 20),
});

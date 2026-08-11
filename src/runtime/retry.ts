const HARD_RETRY_MAX_SECONDS = 24 * 60 * 60;

function boundedPositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

export function retryDelaySeconds(input: {
  attemptCount: number;
  baseSeconds: number;
  maxSeconds: number;
  providerRetryAfterSeconds?: number;
}): number {
  const attempt = boundedPositiveInteger(input.attemptCount, 1);
  const base = boundedPositiveInteger(input.baseSeconds, 5);
  const configuredMax = Math.max(base, boundedPositiveInteger(input.maxSeconds, 300));
  const exponent = Math.min(20, attempt - 1);
  const exponential = Math.min(configuredMax, base * (2 ** exponent));
  if (input.providerRetryAfterSeconds === undefined) return exponential;
  const provider = Math.min(
    HARD_RETRY_MAX_SECONDS,
    boundedPositiveInteger(input.providerRetryAfterSeconds, exponential),
  );
  return Math.max(exponential, provider);
}

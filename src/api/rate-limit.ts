export interface ApiRateLimitPolicy {
  windowMs: number;
  standardLimit: number;
  expensiveLimit: number;
}

export interface ApiRateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
}

interface Counter {
  windowStart: number;
  count: number;
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid API rate-limit value: ${value}`);
  }
  return parsed;
}

export function configuredApiRateLimitPolicy(env: NodeJS.ProcessEnv = process.env): ApiRateLimitPolicy {
  return {
    windowMs: positiveInt(env.API_RATE_LIMIT_WINDOW_MS, 60_000, 1_000, 3_600_000),
    standardLimit: positiveInt(env.API_RATE_LIMIT_STANDARD, 120, 1, 100_000),
    expensiveLimit: positiveInt(env.API_RATE_LIMIT_EXPENSIVE, 30, 1, 100_000),
  };
}

export function isExpensiveApiPath(pathname: string): boolean {
  return pathname.includes("/lineage")
    || pathname.includes("/related")
    || pathname.includes("/routing-context")
    || pathname.includes("/convergence");
}

export class InMemoryApiRateLimiter {
  readonly #policy: ApiRateLimitPolicy;
  readonly #counters = new Map<string, Counter>();

  constructor(policy: ApiRateLimitPolicy = configuredApiRateLimitPolicy()) {
    this.#policy = policy;
  }

  consume(clientId: string, pathname: string, nowMs = Date.now()): ApiRateLimitDecision {
    const expensive = isExpensiveApiPath(pathname);
    const bucket = expensive ? "expensive" : "standard";
    const limit = expensive ? this.#policy.expensiveLimit : this.#policy.standardLimit;
    const windowStart = Math.floor(nowMs / this.#policy.windowMs) * this.#policy.windowMs;
    const key = `${clientId}\u0000${bucket}`;
    let counter = this.#counters.get(key);
    if (!counter || counter.windowStart !== windowStart) {
      counter = { windowStart, count: 0 };
      this.#counters.set(key, counter);
    }
    counter.count += 1;

    const allowed = counter.count <= limit;
    const remaining = Math.max(0, limit - counter.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((windowStart + this.#policy.windowMs - nowMs) / 1_000));

    if (this.#counters.size > 2_048) {
      for (const [counterKey, value] of this.#counters) {
        if (value.windowStart < windowStart) this.#counters.delete(counterKey);
      }
    }

    return { allowed, limit, remaining, retryAfterSeconds };
  }
}

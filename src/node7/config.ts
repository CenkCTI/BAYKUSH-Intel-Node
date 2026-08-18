import { z } from "zod";

const schema = z.object({
  NODE7_IDLE_MS: z.coerce.number().int().min(100).max(60000).default(1000),
  NODE7_DISCOVERY_BATCH: z.coerce.number().int().min(1).max(5000).default(500),
  NODE7_PROCESS_BATCH: z.coerce.number().int().min(1).max(1000).default(100),
  NODE7_LEASE_SECONDS: z.coerce.number().int().min(10).max(900).default(60),
  NODE7_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  NODE7_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
  NODE7_RETRY_MAX_SECONDS: z.coerce.number().int().min(1).max(3600).default(300),
});

const parsed = schema.parse(process.env);
if (parsed.NODE7_RETRY_BASE_SECONDS > parsed.NODE7_RETRY_MAX_SECONDS) {
  throw new Error("NODE7_RETRY_BASE_SECONDS cannot exceed NODE7_RETRY_MAX_SECONDS");
}

export const node7Config = Object.freeze({
  idleMs: parsed.NODE7_IDLE_MS,
  discoveryBatch: parsed.NODE7_DISCOVERY_BATCH,
  processBatch: parsed.NODE7_PROCESS_BATCH,
  leaseSeconds: parsed.NODE7_LEASE_SECONDS,
  maxAttempts: parsed.NODE7_MAX_ATTEMPTS,
  retryBaseSeconds: parsed.NODE7_RETRY_BASE_SECONDS,
  retryMaxSeconds: parsed.NODE7_RETRY_MAX_SECONDS,
});

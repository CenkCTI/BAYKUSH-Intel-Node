import os from "node:os";
import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return value;
}, z.boolean());

const optionalSecretFromEnv = z.preprocess((value) => {
  if (typeof value === "string" && value.trim() === "") return undefined;
  return value;
}, z.string().min(1).max(4_096).optional());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  NODE_INSTANCE_ID: z.string().min(1).max(128).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  SCHEDULER_TICK_MS: z.coerce.number().int().min(250).max(60_000).default(5_000),
  WORKER_IDLE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).max(900).default(60),
  WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  WORKER_RETRY_BASE_SECONDS: z.coerce.number().int().min(1).max(300).default(5),
  WORKER_RETRY_MAX_SECONDS: z.coerce.number().int().min(1).max(3_600).default(300),
  NORMALIZER_IDLE_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  NORMALIZER_LEASE_SECONDS: z.coerce.number().int().min(10).max(900).default(60),
  NORMALIZER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).max(60_000).default(10_000),
  SOURCE_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(30_000),
  MAX_RECORDS_PER_WORK_UNIT: z.coerce.number().int().min(1).max(10_000).default(100),
  GLOBAL_MAX_RECORDS_PER_WORK_UNIT: z.coerce.number().int().min(1).max(10_000).default(10_000),
  MAX_RAW_RECORD_BYTES: z.coerce.number().int().min(1_024).max(64 * 1024 * 1024).default(262_144),
  GLOBAL_MAX_RAW_RECORD_BYTES: z.coerce.number().int().min(1_024).max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  NVD_API_KEY: optionalSecretFromEnv,
  THREATFOX_AUTH_KEY: optionalSecretFromEnv,
  ENABLE_TEST_SYNTHETIC: booleanFromEnv.default(false),
  SYNTHETIC_RECORDS_PER_RUN: z.coerce.number().int().min(1).max(10_000).default(25),
  SYNTHETIC_PAGE_SIZE: z.coerce.number().int().min(1).max(1_000).default(10),
});

const parsed = envSchema.parse(process.env);

if (parsed.MAX_RECORDS_PER_WORK_UNIT > parsed.GLOBAL_MAX_RECORDS_PER_WORK_UNIT) {
  throw new Error("MAX_RECORDS_PER_WORK_UNIT cannot exceed GLOBAL_MAX_RECORDS_PER_WORK_UNIT");
}
if (parsed.MAX_RAW_RECORD_BYTES > parsed.GLOBAL_MAX_RAW_RECORD_BYTES) {
  throw new Error("MAX_RAW_RECORD_BYTES cannot exceed GLOBAL_MAX_RAW_RECORD_BYTES");
}
if (parsed.SYNTHETIC_PAGE_SIZE > parsed.MAX_RECORDS_PER_WORK_UNIT) {
  throw new Error("SYNTHETIC_PAGE_SIZE cannot exceed MAX_RECORDS_PER_WORK_UNIT");
}
if (parsed.WORKER_RETRY_BASE_SECONDS > parsed.WORKER_RETRY_MAX_SECONDS) {
  throw new Error("WORKER_RETRY_BASE_SECONDS cannot exceed WORKER_RETRY_MAX_SECONDS");
}

export const config = Object.freeze({
  databaseUrl: parsed.DATABASE_URL,
  port: parsed.PORT,
  instanceId: parsed.NODE_INSTANCE_ID ?? `${os.hostname()}:${process.pid}`,
  databasePoolMax: parsed.DATABASE_POOL_MAX,
  schedulerTickMs: parsed.SCHEDULER_TICK_MS,
  workerIdleMs: parsed.WORKER_IDLE_MS,
  workerLeaseSeconds: parsed.WORKER_LEASE_SECONDS,
  workerMaxAttempts: parsed.WORKER_MAX_ATTEMPTS,
  workerRetryBaseSeconds: parsed.WORKER_RETRY_BASE_SECONDS,
  workerRetryMaxSeconds: parsed.WORKER_RETRY_MAX_SECONDS,
  normalizerIdleMs: parsed.NORMALIZER_IDLE_MS,
  normalizerLeaseSeconds: parsed.NORMALIZER_LEASE_SECONDS,
  normalizerMaxAttempts: parsed.NORMALIZER_MAX_ATTEMPTS,
  heartbeatIntervalMs: parsed.HEARTBEAT_INTERVAL_MS,
  sourceHttpTimeoutMs: parsed.SOURCE_HTTP_TIMEOUT_MS,
  maxRecordsPerWorkUnit: parsed.MAX_RECORDS_PER_WORK_UNIT,
  globalMaxRecordsPerWorkUnit: parsed.GLOBAL_MAX_RECORDS_PER_WORK_UNIT,
  maxRawRecordBytes: parsed.MAX_RAW_RECORD_BYTES,
  globalMaxRawRecordBytes: parsed.GLOBAL_MAX_RAW_RECORD_BYTES,
  nvdApiKey: parsed.NVD_API_KEY,
  threatFoxAuthKey: parsed.THREATFOX_AUTH_KEY,
  enableTestSynthetic: parsed.ENABLE_TEST_SYNTHETIC,
  syntheticRecordsPerRun: parsed.SYNTHETIC_RECORDS_PER_RUN,
  syntheticPageSize: parsed.SYNTHETIC_PAGE_SIZE,
});

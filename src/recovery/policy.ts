import { createHash } from "node:crypto";

export const RECOVERY_POLICY_REVISION = "NODE6_2_RECOVERY_POLICY_V1" as const;
export const DECODER_CONTRACT_VERSION = "NODE6_2_MRT_DECODER_V1" as const;
export const DECODER_NAME = "BGPKIT_PARSER" as const;
export const DECODER_VERSION = "0.18.0" as const;
export const DECODER_UPSTREAM_TAG = "v0.18.0" as const;
export const DECODER_UPSTREAM_COMMIT = "c39e39037ccf44de2848e9f48ba82d418d745743" as const;

export const recoveryPolicyV1 = Object.freeze({
  revision: RECOVERY_POLICY_REVISION,
  automaticGapMaxSeconds: 30 * 60,
  manualRequestMaxSeconds: 6 * 60 * 60,
  hardMaxSegments: 10_000,
  downloadConcurrency: 2,
  decoderConcurrency: 1,
  projectionConcurrency: 1,
  maxAttempts: 4,
  archiveSettleSeconds: 15 * 60,
});

export const recoveryFailureCodes = [
  "ARCHIVE_NOT_READY",
  "HTTP_NOT_FOUND",
  "HTTP_RATE_LIMITED",
  "HTTP_SERVER_ERROR",
  "DOWNLOAD_TIMEOUT",
  "DOWNLOAD_SIZE_LIMIT",
  "DOWNLOAD_TLS_ERROR",
  "DOWNLOAD_REDIRECT_REJECTED",
  "DISK_WATERMARK",
  "ARTIFACT_HASH_CHANGED",
  "GZIP_INVALID",
  "DECODER_TIMEOUT",
  "DECODER_MEMORY_LIMIT",
  "DECODER_EXIT_NONZERO",
  "DECODER_OUTPUT_INVALID",
  "DECODER_OUTPUT_LIMIT",
  "DECODER_CORRUPT_RECORD",
  "POPULATION_MISMATCH",
  "TIMESTAMP_ANOMALY",
  "PROJECTION_CONFLICT",
  "DATABASE_FAILURE",
] as const;
export type RecoveryFailureCode = typeof recoveryFailureCodes[number];

const retryable = new Set<RecoveryFailureCode>([
  "ARCHIVE_NOT_READY",
  "HTTP_NOT_FOUND",
  "HTTP_RATE_LIMITED",
  "HTTP_SERVER_ERROR",
  "DOWNLOAD_TIMEOUT",
  "DOWNLOAD_TLS_ERROR",
  "DISK_WATERMARK",
  "DATABASE_FAILURE",
]);

export function isRetryableRecoveryFailure(code: RecoveryFailureCode): boolean {
  return retryable.has(code);
}

const automaticReasons = new Set([
  "BACKPRESSURE_LIMIT",
  "PROVIDER_DISCONNECT",
  "DB_UNAVAILABLE",
  "FORCED_TERMINATE",
  "UNEXPECTED_RESTART",
  "NETWORK_DISCONNECT",
]);

export function isAutomaticRecoveryReason(reason: string): boolean {
  return automaticReasons.has(reason);
}

export function recoveryBackoffSeconds(attempt: number, baseSeconds = 30, maxSeconds = 1800): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  return Math.min(maxSeconds, baseSeconds * (2 ** Math.min(attempt - 1, 10)));
}

export function stableSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertRecoveryRange(from: string, to: string, automatic: boolean): { fromMs: number; toMs: number } {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error("Recovery range must be valid RFC3339 with to > from");
  }
  const limit = (automatic ? recoveryPolicyV1.automaticGapMaxSeconds : recoveryPolicyV1.manualRequestMaxSeconds) * 1_000;
  if (toMs - fromMs > limit) throw new Error("Recovery range exceeds NODE6_2_RECOVERY_POLICY_V1 bound");
  return { fromMs, toMs };
}

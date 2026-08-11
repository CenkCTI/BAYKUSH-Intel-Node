import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../config.js";
import { canonicalEvidenceDraftSchema, type CanonicalEvidenceDraft } from "../contracts/canonical.js";
import { pool, withTransaction } from "../db/pool.js";
import { adapterRegistry } from "../sources/registry.js";
import { CollectionFailure, safeFailureMessage } from "./failure.js";
import { canonicalJsonStringify } from "./raw-record.js";
import { retryDelaySeconds } from "./retry.js";

interface ClaimedNormalizationJob {
  id: string;
  rawRecordId: string;
  sourceDefinitionId: string;
  sourceKey: string;
  sourceRecordId: string;
  upstreamOriginKey: string;
  normalizationVersion: string;
  attemptCount: number;
  payload: unknown;
  receivedAt: Date;
  publishedAt: Date | null;
  effectiveAt: Date | null;
  upstreamUpdatedAt: Date | null;
}

async function claimNormalizationJob(workerId: string, leaseSeconds: number): Promise<ClaimedNormalizationJob | null> {
  return withTransaction(async (client) => {
    const selected = await client.query<{
      id: string;
      raw_record_id: string;
      source_definition_id: string;
      source_key: string;
      source_record_id: string;
      upstream_origin_key: string;
      normalization_version: string;
      attempt_count: number;
      payload: unknown;
      received_at: Date;
      published_at: Date | null;
      effective_at: Date | null;
      upstream_updated_at: Date | null;
    }>(
      `SELECT j.id, j.raw_record_id, j.source_definition_id, d.source_key,
              r.source_record_id, d.upstream_origin_key, j.normalization_version,
              j.attempt_count, r.payload, r.received_at, r.published_at,
              r.effective_at, r.upstream_updated_at
       FROM normalization_jobs j
       JOIN raw_source_records r ON r.id = j.raw_record_id
       JOIN source_definitions d ON d.id = j.source_definition_id
       WHERE (j.state = 'QUEUED' AND j.available_at <= now())
          OR (j.state = 'RUNNING' AND j.lease_expires_at < now())
       ORDER BY j.created_at
       FOR UPDATE OF j SKIP LOCKED
       LIMIT 1`,
    );
    const row = selected.rows[0];
    if (!row) return null;
    const claimed = await client.query<{ attempt_count: number }>(
      `UPDATE normalization_jobs
       SET state = 'RUNNING', attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, now()), lease_owner = $2,
           lease_expires_at = now() + ($3::text || ' seconds')::interval,
           updated_at = now()
       WHERE id = $1
       RETURNING attempt_count`,
      [row.id, workerId, leaseSeconds],
    );
    return {
      id: row.id,
      rawRecordId: row.raw_record_id,
      sourceDefinitionId: row.source_definition_id,
      sourceKey: row.source_key,
      sourceRecordId: row.source_record_id,
      upstreamOriginKey: row.upstream_origin_key,
      normalizationVersion: row.normalization_version,
      attemptCount: claimed.rows[0]?.attempt_count ?? row.attempt_count + 1,
      payload: row.payload,
      receivedAt: row.received_at,
      publishedAt: row.published_at,
      effectiveAt: row.effective_at,
      upstreamUpdatedAt: row.upstream_updated_at,
    };
  });
}

async function assertNormalizationLease(client: PoolClient, jobId: string, workerId: string): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM normalization_jobs
     WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2
     FOR UPDATE`,
    [jobId, workerId],
  );
  if (!result.rowCount) throw new Error("Normalization lease was lost before persistence");
}

function canonicalFingerprint(input: {
  draft: CanonicalEvidenceDraft;
  semanticBoundary: { represents: string; doesNotRepresent: string };
  normalizationVersion: string;
}): string {
  return createHash("sha256").update(canonicalJsonStringify(input)).digest("hex");
}

async function persistNormalizationSuccess(input: {
  job: ClaimedNormalizationJob;
  workerId: string;
  drafts: readonly CanonicalEvidenceDraft[];
}): Promise<void> {
  const adapter = adapterRegistry.get(input.job.sourceKey);
  if (!adapter) throw new Error(`No registered adapter for ${input.job.sourceKey}`);
  await withTransaction(async (client) => {
    await assertNormalizationLease(client, input.job.id, input.workerId);
    let written = 0;
    for (const draft of input.drafts) {
      const normalizedSha256 = canonicalFingerprint({
        draft,
        semanticBoundary: adapter.definition.semanticBoundary,
        normalizationVersion: input.job.normalizationVersion,
      });
      const result = await client.query(
        `INSERT INTO canonical_evidence_records(
           raw_record_id, source_definition_id, source_record_id, upstream_origin_key,
           canonical_key, record_kind, received_at, published_at, effective_at,
           upstream_updated_at, entities, facts, reference_urls, semantic_boundary,
           adapter_version, normalization_version, semantic_contract_version, normalized_sha256
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16,$17,$18
         )
         ON CONFLICT (raw_record_id, normalization_version, canonical_key, record_kind) DO NOTHING`,
        [
          input.job.rawRecordId,
          input.job.sourceDefinitionId,
          input.job.sourceRecordId,
          input.job.upstreamOriginKey,
          draft.canonicalKey,
          draft.recordKind,
          input.job.receivedAt,
          input.job.publishedAt,
          input.job.effectiveAt,
          input.job.upstreamUpdatedAt,
          canonicalJsonStringify(draft.entities),
          canonicalJsonStringify(draft.facts),
          canonicalJsonStringify(draft.references),
          canonicalJsonStringify(adapter.definition.semanticBoundary),
          adapter.definition.adapterVersion,
          input.job.normalizationVersion,
          adapter.definition.semanticContractVersion,
          normalizedSha256,
        ],
      );
      written += result.rowCount ?? 0;
    }
    await client.query(
      `UPDATE normalization_jobs
       SET state = 'SUCCEEDED', canonical_records_written = $2,
           finished_at = now(), lease_owner = NULL, lease_expires_at = NULL,
           failure_code = NULL, failure_message = NULL, updated_at = now()
       WHERE id = $1`,
      [input.job.id, written],
    );
  });
}

async function persistNormalizationFailure(input: {
  job: ClaimedNormalizationJob;
  workerId: string;
  code: string;
  message: string;
  retryable: boolean;
}): Promise<void> {
  await withTransaction(async (client) => {
    await assertNormalizationLease(client, input.job.id, input.workerId);
    const retry = input.retryable && input.job.attemptCount < config.normalizerMaxAttempts;
    const delaySeconds = retry ? retryDelaySeconds({
      attemptCount: input.job.attemptCount,
      baseSeconds: config.workerRetryBaseSeconds,
      maxSeconds: config.workerRetryMaxSeconds,
    }) : 0;
    await client.query(
      `UPDATE normalization_jobs
       SET state = $2, lease_owner = NULL, lease_expires_at = NULL,
           available_at = CASE WHEN $2 = 'QUEUED' THEN now() + ($5::int * interval '1 second') ELSE available_at END,
           finished_at = CASE WHEN $2 = 'FAILED' THEN now() ELSE NULL END,
           failure_code = $3, failure_message = $4, updated_at = now()
       WHERE id = $1`,
      [input.job.id, retry ? "QUEUED" : "FAILED", input.code, safeFailureMessage(input.message), delaySeconds],
    );
  });
}

export async function normalizerTick(workerId = config.instanceId): Promise<boolean> {
  const job = await claimNormalizationJob(workerId, config.normalizerLeaseSeconds);
  if (!job) return false;
  const adapter = adapterRegistry.get(job.sourceKey);
  if (!adapter) {
    await persistNormalizationFailure({
      job,
      workerId,
      code: "ADAPTER_NOT_REGISTERED",
      message: `No registered adapter for ${job.sourceKey}`,
      retryable: false,
    });
    return true;
  }
  if (adapter.normalizationVersion !== job.normalizationVersion) {
    await persistNormalizationFailure({
      job,
      workerId,
      code: "NORMALIZATION_VERSION_UNAVAILABLE",
      message: `Normalization version ${job.normalizationVersion} is not available for ${job.sourceKey}`,
      retryable: false,
    });
    return true;
  }

  try {
    const drafts = adapter.normalize(job.payload).map((draft) => canonicalEvidenceDraftSchema.parse(draft));
    await persistNormalizationSuccess({ job, workerId, drafts });
  } catch (error) {
    const failure = error instanceof CollectionFailure
      ? { code: error.code, message: error.message, retryable: error.retryable }
      : { code: "NORMALIZATION_SCHEMA_ERROR", message: "Canonical normalization failed", retryable: false };
    await persistNormalizationFailure({ job, workerId, ...failure });
  }
  return true;
}

export async function normalizationQueueDepth(): Promise<number> {
  const result = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM normalization_jobs
     WHERE state IN ('QUEUED','RUNNING')`,
  );
  return result.rows[0]?.count ?? 0;
}

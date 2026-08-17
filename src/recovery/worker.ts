import { config } from "../config.js";
import { recoveryDecoderBinarySha256, runMrtDecoder } from "./decoder.js";
import { RecoveryFailure } from "./errors.js";
import { downloadRipeMrtArtifact } from "./fetcher.js";
import type { RecoveryFailureCode } from "./policy.js";
import { RecoveryProjectionAccumulator } from "./projection.js";
import {
  claimRecoverySegment,
  failDecoderRun,
  finishDecoderRun,
  markArtifactVerified,
  markRecoverySegmentFailure,
  persistRecoveryProjection,
  recordDownloadedArtifact,
  startDecoderRun,
  streamHealthyForRecovery,
  type ClaimedRecoverySegment,
} from "./repository.js";
import { expireRecoveryArtifacts } from "./retention.js";
import { scanAutomaticRecoveryCandidates } from "./scanner.js";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function classifyFailure(error: unknown): { code: RecoveryFailureCode; message: string } {
  if (error instanceof RecoveryFailure) return { code: error.code, message: error.message };
  if (error instanceof Error && error.message === "POPULATION_MISMATCH") return { code: "POPULATION_MISMATCH", message: error.message };
  if (error instanceof Error && error.message === "TIMESTAMP_ANOMALY") return { code: "TIMESTAMP_ANOMALY", message: error.message };
  if (error instanceof Error && error.message === "PROJECTION_CONFLICT") return { code: "PROJECTION_CONFLICT", message: error.message };
  return { code: "DATABASE_FAILURE", message: error instanceof Error ? error.message : String(error) };
}

export async function processRecoverySegment(segment: ClaimedRecoverySegment): Promise<void> {
  let decoderRunId: string | undefined;
  try {
    const artifact = await downloadRipeMrtArtifact({
      segmentId: segment.segmentId,
      sourceUrl: segment.sourceUrl,
      windowEnd: segment.windowEnd,
    });
    const saved = await recordDownloadedArtifact(segment, artifact);
    await markArtifactVerified(segment, saved.artifactId);
    const binarySha = await recoveryDecoderBinarySha256();
    decoderRunId = await startDecoderRun(segment, saved.artifactId, artifact.sha256, binarySha);
    const accumulator = new RecoveryProjectionAccumulator({
      rrc: segment.rrc,
      artifactWindowStart: segment.windowStart,
      artifactWindowEnd: segment.windowEnd,
      targetFrom: segment.requestedFrom,
      targetTo: segment.requestedTo,
    });
    const decoded = await runMrtDecoder({
      artifactPath: artifact.absolutePath,
      artifactSha256: artifact.sha256,
      rrc: segment.rrc,
      onObservation: (observation) => accumulator.accept(observation),
    });
    await finishDecoderRun(segment, decoderRunId, decoded);
    await persistRecoveryProjection({
      segment,
      artifactId: saved.artifactId,
      decoderRunId,
      decoder: decoded,
      deltas: accumulator.finalize(),
    });
  } catch (error) {
    const failure = classifyFailure(error);
    if (decoderRunId) await failDecoderRun(decoderRunId, failure.code, failure.message).catch(() => undefined);
    await markRecoverySegmentFailure(segment, failure.code, failure.message);
  }
}

export async function runRecoveryWorker(signal?: AbortSignal): Promise<void> {
  let nextMaintenanceAt = 0;
  while (!signal?.aborted) {
    if (Date.now() >= nextMaintenanceAt) {
      nextMaintenanceAt = Date.now() + 60_000;
      await expireRecoveryArtifacts().catch((error) => {
        console.error("[RECOVERY_WORKER] artifact retention failed", error);
      });
      await scanAutomaticRecoveryCandidates().catch((error) => {
        console.error("[RECOVERY_WORKER] automatic recovery scan failed", error);
      });
    }
    if (!(await streamHealthyForRecovery())) {
      await wait(config.recoveryIdleMs);
      continue;
    }
    const segment = await claimRecoverySegment(config.instanceId);
    if (!segment) {
      await wait(config.recoveryIdleMs);
      continue;
    }
    await processRecoverySegment(segment);
  }
}

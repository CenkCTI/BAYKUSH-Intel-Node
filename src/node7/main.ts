import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { node7Config } from "./config.js";
import {
  claimDirtyEntity,
  completeDirtyEntity,
  dirtyQueueDepth,
  failDirtyEntity,
} from "./dirty-queue.js";
import {
  discoverEntityObservationRevisions,
  discoverSourceSemanticDrift,
} from "./entity-registry.js";
import { recomputeEntitySourcePresence } from "./source-presence.js";

let stopping = false;
const heartbeatMetadata: Record<string, unknown> = {
  subsystem: "node7-entity-discovery",
  schemaVersion: "NODE7AB_RUNTIME_V1",
  queueDepth: 0,
  lastProjectionAt: null,
  entitiesProcessed: 0,
  presenceRevisionsWritten: 0,
};
const stopHeartbeat = startHeartbeatLoop("NODE7_WORKER", heartbeatMetadata);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function node7Loop(): Promise<void> {
  while (!stopping) {
    let didWork = 0;
    try {
      didWork += await discoverEntityObservationRevisions(node7Config.discoveryBatch);
      didWork += await discoverSourceSemanticDrift(node7Config.discoveryBatch);

      let processed = 0;
      let revisionsWritten = 0;
      for (let index = 0; index < node7Config.processBatch && !stopping; index += 1) {
        const claim = await claimDirtyEntity({
          workerId: config.instanceId,
          leaseSeconds: node7Config.leaseSeconds,
          maxAttempts: node7Config.maxAttempts,
        });
        if (!claim) break;

        try {
          revisionsWritten += await recomputeEntitySourcePresence(claim.entityId);
          await completeDirtyEntity({
            workerId: config.instanceId,
            entityId: claim.entityId,
            dirtyRevision: claim.dirtyRevision,
          });
          processed += 1;
          heartbeatMetadata.lastProjectionAt = new Date().toISOString();
        } catch (error) {
          await failDirtyEntity({
            workerId: config.instanceId,
            entityId: claim.entityId,
            attemptCount: claim.attemptCount,
            retryBaseSeconds: node7Config.retryBaseSeconds,
            retryMaxSeconds: node7Config.retryMaxSeconds,
            error,
          });
          console.error("NODE-7 entity projection failed", { entityId: claim.entityId, error });
        }
      }

      didWork += processed;
      heartbeatMetadata.entitiesProcessed = Number(heartbeatMetadata.entitiesProcessed ?? 0) + processed;
      heartbeatMetadata.presenceRevisionsWritten =
        Number(heartbeatMetadata.presenceRevisionsWritten ?? 0) + revisionsWritten;
      heartbeatMetadata.queueDepth = await dirtyQueueDepth();
    } catch (error) {
      console.error("NODE-7 worker tick failed", error);
    }

    if (didWork === 0) await sleep(node7Config.idleMs);
  }
}

function requestShutdown(signal: string): void {
  if (stopping) return;
  console.log(`NODE-7 worker received ${signal}; shutting down`);
  stopping = true;
  stopHeartbeat();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
await node7Loop();
await pool.end();

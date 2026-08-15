import WebSocket, { type RawData } from "ws";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { startHeartbeatLoop } from "../runtime/heartbeat.js";
import { BoundedStreamQueue } from "./queue.js";
import { RIPE_RIS_LIVE_URL, ripeRisSubscription } from "./ripe-ris/source.js";
import {
  attachCaptureProfile,
  createStreamSession,
  ensureCaptureProfile,
  ensureCoveredMinute,
  loadRipeSourceState,
  persistStreamSegment,
  recordStreamEvent,
  updateStreamSession,
} from "./repository.js";
import { purgeExpiredStreamPayloads } from "./retention.js";

let stopping = false;
const CLOSE_GRACE_MS = 3_000;

type CloseIntent =
  | "SOURCE_DISABLED"
  | "WORKER_SHUTDOWN"
  | "BACKPRESSURE"
  | "DB_UNAVAILABLE"
  | "MESSAGE_TOO_LARGE"
  | "PROVIDER_ERROR";

let closeActiveSession: ((intent: CloseIntent) => void) | null = null;

const stopHeartbeat = startHeartbeatLoop("STREAM_WORKER", {
  subsystem: "routing-stream",
  sourceKey: "RIPE_RIS_BGP",
  schemaVersion: "NODE6_STREAM_V1",
});

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function rrcList(data: unknown): string[] {
  return Array.isArray(data)
    ? data.filter((value): value is string => typeof value === "string")
    : [];
}

function closeSpec(intent: CloseIntent): { code: number; reason: string } {
  switch (intent) {
    case "SOURCE_DISABLED":
      return { code: 1000, reason: "source disabled" };
    case "WORKER_SHUTDOWN":
      return { code: 1001, reason: "worker shutdown" };
    case "MESSAGE_TOO_LARGE":
      return { code: 1009, reason: "message too large" };
    case "PROVIDER_ERROR":
      return { code: 1011, reason: "provider error" };
    case "BACKPRESSURE":
      return { code: 1013, reason: "backpressure" };
    case "DB_UNAVAILABLE":
      return { code: 1013, reason: "database unavailable" };
  }
}

async function runSession(sourceDefinitionId: string): Promise<void> {
  const sessionId = await createStreamSession(sourceDefinitionId, config.instanceId);
  const queue = new BoundedStreamQueue(config.streamQueueMaxMessages, config.streamQueueMaxBytes);
  let profileId: string | null = null;
  let sequence = 0;
  let flushing = false;
  let subscribed = false;
  let closeIntent: CloseIntent | null = null;
  let closeCode: number | null = null;
  let closeReason = "";
  let sourceCheckRunning = false;
  let closeFallbackTimer: NodeJS.Timeout | null = null;

  const socket = new WebSocket(RIPE_RIS_LIVE_URL, {
    handshakeTimeout: 15_000,
    maxPayload: config.streamMaxMessageBytes,
    perMessageDeflate: false,
  });

  const armCloseFallback = (intent: CloseIntent): void => {
    if (closeFallbackTimer) return;
    closeFallbackTimer = setTimeout(() => {
      if (socket.readyState === WebSocket.CLOSED) return;
      void recordStreamEvent(sessionId, "FORCED_TERMINATE", {
        intent,
        graceMs: CLOSE_GRACE_MS,
        readyState: socket.readyState,
      }).catch(() => undefined);
      socket.terminate();
    }, CLOSE_GRACE_MS);
  };

  const requestClose = (intent: CloseIntent): void => {
    if (closeIntent) return;
    closeIntent = intent;
    const spec = closeSpec(intent);

    if (intent === "SOURCE_DISABLED" || intent === "WORKER_SHUTDOWN") {
      void updateStreamSession(sessionId, "DRAINING", spec.reason).catch(() => undefined);
      void recordStreamEvent(sessionId, "DRAIN_REQUESTED", { intent }).catch(() => undefined);
    }

    if (socket.readyState === WebSocket.OPEN) {
      socket.close(spec.code, spec.reason);
      armCloseFallback(intent);
    } else if (socket.readyState === WebSocket.CONNECTING) {
      socket.terminate();
    }
  };

  closeActiveSession = requestClose;

  const flush = async (): Promise<void> => {
    if (flushing || queue.size === 0) return;
    flushing = true;
    try {
      const messages = queue.drain(config.streamSegmentMaxMessages, config.streamSegmentMaxBytes);
      if (messages.length) {
        await persistStreamSegment({
          sourceDefinitionId,
          sessionId,
          profileId,
          sequence: sequence++,
          messages,
          rawRetentionHours: config.streamRawRetentionHours,
        });
      }
    } finally {
      flushing = false;
    }
  };

  const drainTimer = setInterval(() => {
    void flush().catch(async (error) => {
      console.error("stream segment flush failed", error);
      await recordStreamEvent(sessionId, "DB_UNAVAILABLE", {}).catch(() => undefined);
      requestClose("DB_UNAVAILABLE");
    });
  }, config.streamFlushIntervalMs);

  const zeroTimer = setInterval(() => {
    if (subscribed && profileId && !closeIntent) {
      void ensureCoveredMinute({
        sourceDefinitionId,
        profileId,
        instant: new Date(),
      }).catch((error) => console.error("covered-minute scheduling failed", error));
    }
  }, 10_000);

  const sourceStateTimer = setInterval(() => {
    if (sourceCheckRunning || closeIntent) return;
    sourceCheckRunning = true;
    void loadRipeSourceState()
      .then((source) => {
        if (!source?.enabled) requestClose("SOURCE_DISABLED");
      })
      .catch((error) => console.error("stream source state check failed", error))
      .finally(() => {
        sourceCheckRunning = false;
      });
  }, 1_000);

  await new Promise<void>((resolve) => {
    socket.on("open", () => {
      if (stopping) {
        requestClose("WORKER_SHUTDOWN");
        return;
      }
      void updateStreamSession(sessionId, "CONNECTED");
      void recordStreamEvent(sessionId, "CONNECTED");
      socket.send(JSON.stringify({ type: "request_rrc_list" }));
      socket.send(JSON.stringify({ type: "ris_subscribe", data: ripeRisSubscription }));
    });

    socket.on("message", (data: RawData) => {
      if (closeIntent) return;
      const raw = typeof data === "string" ? data : data.toString("utf8");
      if (Buffer.byteLength(raw) > config.streamMaxMessageBytes) {
        void recordStreamEvent(sessionId, "SCHEMA_REJECTION", { reason: "MESSAGE_TOO_LARGE" });
        requestClose("MESSAGE_TOO_LARGE");
        return;
      }

      try {
        const parsed = JSON.parse(raw) as { type?: unknown; data?: unknown };
        const type = typeof parsed.type === "string" ? parsed.type : null;

        if (type === "ris_rrc_list") {
          const rrcs = rrcList(parsed.data);
          if (rrcs.length === 0) {
            void recordStreamEvent(sessionId, "SCHEMA_REJECTION", { reason: "EMPTY_RRC_LIST" });
            return;
          }
          void ensureCaptureProfile(sourceDefinitionId, rrcs).then(async (id) => {
            profileId = id;
            await attachCaptureProfile(sessionId, id);
            await recordStreamEvent(sessionId, "RRC_LIST_RECEIVED", { rrcCount: rrcs.length });
          });
          return;
        }

        if (type === "ris_subscribe_ok") {
          subscribed = true;
          void updateStreamSession(sessionId, "STREAMING");
          void recordStreamEvent(sessionId, "SUBSCRIBED");
          return;
        }

        if (type === "ris_error") {
          void recordStreamEvent(sessionId, "PROVIDER_ERROR", {
            data: parsed.data ?? null,
          });
          requestClose("PROVIDER_ERROR");
          return;
        }

        if (type !== "ris_message") return;
      } catch {
        void recordStreamEvent(sessionId, "SCHEMA_REJECTION", { reason: "INVALID_JSON" });
        return;
      }

      const receivedAt = new Date().toISOString();
      const item = { raw, receivedAt, bytes: Buffer.byteLength(raw) };
      if (!queue.push(item)) {
        void recordStreamEvent(sessionId, "BACKPRESSURE_LIMIT", {
          queuedMessages: queue.size,
          queuedBytes: queue.bytes,
        });
        requestClose("BACKPRESSURE");
      }
    });

    socket.on("error", (error) => {
      console.error("RIPE RIS stream error", error);
      void recordStreamEvent(sessionId, "PROVIDER_ERROR", {
        message: error instanceof Error ? error.message.slice(0, 512) : "unknown websocket error",
      });
    });

    socket.on("close", (code, reason) => {
      closeCode = code;
      closeReason = reason.toString("utf8").slice(0, 512);
      if (closeFallbackTimer) {
        clearTimeout(closeFallbackTimer);
        closeFallbackTimer = null;
      }
      resolve();
    });
  });

  clearInterval(drainTimer);
  clearInterval(zeroTimer);
  clearInterval(sourceStateTimer);
  if (closeFallbackTimer) clearTimeout(closeFallbackTimer);
  if (closeActiveSession === requestClose) closeActiveSession = null;

  await flush().catch(() => undefined);

  const operatorClosed = closeIntent === "SOURCE_DISABLED" || closeIntent === "WORKER_SHUTDOWN" || stopping;
  if (operatorClosed) {
    const reason = closeIntent === "SOURCE_DISABLED" ? "source disabled" : "worker shutdown";
    await updateStreamSession(sessionId, "CLOSED", reason);
    await recordStreamEvent(sessionId, "CLOSED", {
      code: closeCode,
      reason: closeReason,
      intent: closeIntent ?? "WORKER_SHUTDOWN",
    }).catch(() => undefined);
  } else {
    await updateStreamSession(sessionId, "FAILED", "stream disconnected");
    await recordStreamEvent(sessionId, "PROVIDER_DISCONNECT", {
      code: closeCode,
      reason: closeReason,
      initiatedByNode: closeIntent !== null,
      closeIntent,
    }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  let attempt = 0;
  let lastRetention = 0;

  while (!stopping) {
    if (Date.now() - lastRetention > 3_600_000) {
      lastRetention = Date.now();
      void purgeExpiredStreamPayloads(10_000).catch((error) => console.error("stream retention failed", error));
    }

    const source = await loadRipeSourceState();
    if (!source?.enabled) {
      attempt = 0;
      await sleep(config.streamIdleMs);
      continue;
    }

    try {
      await runSession(source.id);
      attempt += 1;
    } catch (error) {
      console.error("stream session failed", error);
      attempt += 1;
    }

    if (!stopping) {
      const delay = Math.min(
        config.streamReconnectMaxMs,
        config.streamReconnectBaseMs * 2 ** Math.min(attempt, 8),
      );
      await sleep(delay);
    }
  }
}

function shutdown(signal: string): void {
  if (stopping) return;
  console.log(`stream worker received ${signal}; shutting down`);
  stopping = true;
  stopHeartbeat();
  closeActiveSession?.("WORKER_SHUTDOWN");
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

await main();
await pool.end();

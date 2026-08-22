import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db/pool.js";
import { sendEnvelope } from "./http.js";

interface HeartbeatRow {
  component: string;
  instance_id: string;
  heartbeat_at: Date;
  heartbeat_age_seconds: string;
  fresh: boolean;
  metadata: unknown;
}

interface SourceHealthRow {
  source_key: string;
  health_status: string | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  consecutive_failures: number | null;
  latest_failure_code: string | null;
  updated_at: Date | null;
}

export async function handleOpsApi(
  _request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestIdValue: string,
): Promise<boolean> {
  if (url.pathname !== "/v1/ops/health") return false;

  const [clock, heartbeats, sources] = await Promise.all([
    pool.query<{ now: Date }>("SELECT now() AS now"),
    pool.query<HeartbeatRow>(`
      SELECT component,instance_id,heartbeat_at,heartbeat_age_seconds::text,fresh,metadata
      FROM node_runtime_component_health
      WHERE component <> 'API'
      ORDER BY component,instance_id
      LIMIT 100
    `),
    pool.query<SourceHealthRow>(`
      SELECT s.source_key,h.health_status,h.last_attempt_at,h.last_success_at,h.last_failure_at,
             h.consecutive_failures,h.latest_failure_code,h.updated_at
      FROM source_definitions s
      LEFT JOIN source_health h ON h.source_definition_id=s.id
      WHERE s.enabled=true
      ORDER BY h.last_success_at ASC NULLS FIRST,s.source_key
      LIMIT 100
    `),
  ]);

  const sourceCounts: Record<string, number> = {};
  for (const row of sources.rows) {
    const key = row.health_status ?? "UNKNOWN";
    sourceCounts[key] = (sourceCounts[key] ?? 0) + 1;
  }

  sendEnvelope(response, 200, {
    database: {
      reachable: true,
      observedAt: clock.rows[0]?.now.toISOString() ?? new Date().toISOString(),
    },
    api: {
      servingThisRequest: true,
      heartbeatMode: process.env.API_HEARTBEAT_MODE === "PROBE_ONLY" ? "PROBE_ONLY" : "DATABASE",
    },
    runtimeComponents: heartbeats.rows.map((row) => ({
      component: row.component,
      instanceId: row.instance_id,
      heartbeatAt: row.heartbeat_at.toISOString(),
      heartbeatAgeSeconds: Number(row.heartbeat_age_seconds),
      fresh: row.fresh,
      metadata: row.metadata,
    })),
    sources: {
      enabledCount: sources.rowCount,
      statusCounts: sourceCounts,
      items: sources.rows.map((row) => ({
        sourceKey: row.source_key,
        healthStatus: row.health_status ?? "UNKNOWN",
        lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
        lastSuccessAt: row.last_success_at?.toISOString() ?? null,
        lastFailureAt: row.last_failure_at?.toISOString() ?? null,
        consecutiveFailures: row.consecutive_failures ?? 0,
        latestFailureCode: row.latest_failure_code,
        updatedAt: row.updated_at?.toISOString() ?? null,
      })),
    },
    semantics: {
      sourceHealthRepresents: "Collection/provider pipeline health and freshness.",
      sourceHealthDoesNotRepresent: "Threat level, attack volume, adversary activity or victim impact.",
      missingHeartbeatMeans: "The component is stale, absent, not yet started or unable to persist a heartbeat; it is not evidence of zero workload.",
    },
  }, requestIdValue, { maxRuntimeComponents: 100, maxSources: 100 });
  return true;
}

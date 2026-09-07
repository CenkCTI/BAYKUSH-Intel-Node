import type { IncomingMessage, ServerResponse } from "node:http";
import { pool } from "../db/pool.js";
import { sendEnvelope } from "./http.js";

interface HeartbeatRow {
  component: string;
  instance_id: string;
  heartbeat_at: Date;
  heartbeat_age_seconds: string;
  fresh: boolean;
}

export interface SourceHealthRow {
  source_key: string;
  health_status: string | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_failure_at: Date | null;
  consecutive_failures: number | null;
  latest_failure_code: string | null;
  updated_at: Date | null;
  default_poll_interval_seconds: number | null;
  coverage_status: string | null;
  coverage_evaluated_through: Date | null;
}

export const HEARTBEAT_STALE_SECONDS = 60;
export const EXPECTED_RUNTIME_COMPONENTS = [
  "SCHEDULER", "WORKER", "NORMALIZER", "MEASUREMENT", "BACKFILL",
  "STREAM_WORKER", "RECOVERY_WORKER", "DISCOVERY_WORKER",
] as const;

export function apiHeartbeatMode(env: NodeJS.ProcessEnv = process.env): "PROBE_ONLY" | "DATABASE" {
  return env.API_HEARTBEAT_MODE === "PROBE_ONLY"
    || (env.API_HEARTBEAT_MODE === undefined && env.NODE_ENV === "production")
    ? "PROBE_ONLY" : "DATABASE";
}

export function sourceOperationalState(row: SourceHealthRow, observedAt: Date): string {
  if (row.last_attempt_at === null && row.last_success_at === null && row.last_failure_at === null) return "NEVER_RUN";
  if (row.last_failure_at !== null && (row.last_success_at === null || row.last_failure_at > row.last_success_at)) return "RECENT_FAILURE";
  if (row.last_success_at === null) return "UNKNOWN";
  const staleAfterSeconds = Math.max(1, row.default_poll_interval_seconds ?? 86_400) * 2;
  if (observedAt.getTime() - row.last_success_at.getTime() > staleAfterSeconds * 1_000) return "STALE";
  return row.health_status ?? "UNKNOWN";
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
      SELECT component,instance_id,heartbeat_at,heartbeat_age_seconds::text,fresh
      FROM node_runtime_component_health
      WHERE component <> 'API'
      ORDER BY component,instance_id
      LIMIT 100
    `),
    pool.query<SourceHealthRow>(`
      SELECT s.source_key,s.default_poll_interval_seconds,h.health_status,h.last_attempt_at,h.last_success_at,h.last_failure_at,
             h.consecutive_failures,h.latest_failure_code,h.updated_at,
             coverage.coverage_status,coverage.coverage_evaluated_through
      FROM source_definitions s
      LEFT JOIN source_health h ON h.source_definition_id=s.id
      LEFT JOIN LATERAL (
        SELECT r.coverage_status,head.bucket_end AS coverage_evaluated_through
        FROM source_coverage_bucket_heads head
        JOIN source_coverage_bucket_revisions r ON r.id=head.current_revision_id
        WHERE head.source_definition_id=s.id
        ORDER BY head.bucket_end DESC LIMIT 1
      ) coverage ON true
      WHERE s.enabled=true
      ORDER BY h.last_success_at ASC NULLS FIRST,s.source_key
      LIMIT 100
    `),
  ]);

  const observedAt = clock.rows[0]?.now ?? new Date();
  const sourceCounts: Record<string, number> = {};
  for (const row of sources.rows) {
    const key = sourceOperationalState(row, observedAt);
    sourceCounts[key] = (sourceCounts[key] ?? 0) + 1;
  }

  const runtimeComponents: Array<{
    component: string;
    instanceId: string | null;
    heartbeatAt: string | null;
    heartbeatAgeSeconds: number | null;
    status: "FRESH" | "STALE" | "MISSING";
  }> = heartbeats.rows.map((row) => ({
    component: row.component,
    instanceId: row.instance_id,
    heartbeatAt: row.heartbeat_at.toISOString(),
    heartbeatAgeSeconds: Number(row.heartbeat_age_seconds),
    status: row.fresh ? "FRESH" : "STALE",
  }));
  const presentComponents = new Set(heartbeats.rows.map((row) => row.component));
  for (const component of EXPECTED_RUNTIME_COMPONENTS) {
    if (!presentComponents.has(component)) runtimeComponents.push({
      component, instanceId: null, heartbeatAt: null, heartbeatAgeSeconds: null, status: "MISSING",
    });
  }

  sendEnvelope(response, 200, {
    database: {
      reachable: true,
      observedAt: observedAt.toISOString(),
    },
    api: {
      servingThisRequest: true,
      heartbeatMode: apiHeartbeatMode(),
    },
    runtimeComponents,
    sources: {
      enabledCount: sources.rowCount,
      statusCounts: sourceCounts,
      items: sources.rows.map((row) => ({
        sourceKey: row.source_key,
        reportedHealthStatus: row.health_status ?? "UNKNOWN",
        operationalState: sourceOperationalState(row, observedAt),
        lastAttemptAt: row.last_attempt_at?.toISOString() ?? null,
        lastSuccessAt: row.last_success_at?.toISOString() ?? null,
        lastFailureAt: row.last_failure_at?.toISOString() ?? null,
        consecutiveFailures: row.consecutive_failures,
        latestFailureCode: row.latest_failure_code,
        updatedAt: row.updated_at?.toISOString() ?? null,
        staleAfterSeconds: Math.max(1, row.default_poll_interval_seconds ?? 86_400) * 2,
        latestCoverage: row.coverage_status ?? "UNKNOWN",
        coverageEvaluatedThrough: row.coverage_evaluated_through?.toISOString() ?? null,
      })),
    },
    semantics: {
      sourceHealthRepresents: "Collection/provider pipeline health and freshness.",
      sourceHealthDoesNotRepresent: "Threat level, attack volume, adversary activity or victim impact.",
      unknownOrStaleMeans: "Operational uncertainty or degradation; it is not evidence of zero workload, zero incidents or no attacks.",
      coverageMeans: "Collection coverage evidence only; missing coverage is not evidence of no activity.",
      infrastructureHealthDoesNotRepresent: "Adversary activity, attacker origin, incident count or intelligence severity.",
    },
  }, requestIdValue, { maxRuntimeComponents: 108, maxSources: 100, heartbeatStaleSeconds: HEARTBEAT_STALE_SECONDS });
  return true;
}

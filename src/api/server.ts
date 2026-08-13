import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pool } from "../db/pool.js";
import { handleComparisonApi } from "../measurement/comparison-api.js";
import { handleMeasurementApi } from "../measurement/api.js";
import { handleMeasurementProvenanceApi } from "../measurement/provenance-api.js";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

async function health(response: ServerResponse): Promise<void> {
  try {
    await pool.query("SELECT 1");
    const heartbeats = await pool.query<{
      component: string;
      instance_id: string;
      heartbeat_at: Date;
    }>(
      `SELECT DISTINCT ON (component) component,instance_id,heartbeat_at
       FROM runtime_heartbeats
       ORDER BY component,heartbeat_at DESC`,
    );

    sendJson(response, 200, {
      apiVersion: "v1",
      generatedAt: new Date().toISOString(),
      data: {
        status: "ok",
        database: "ok",
        heartbeats: heartbeats.rows.map((row) => ({
          component: row.component,
          instanceId: row.instance_id,
          heartbeatAt: row.heartbeat_at.toISOString(),
        })),
      },
      meta: { serviceVersion: "node-3-v1" },
    });
  } catch {
    sendJson(response, 503, {
      apiVersion: "v1",
      generatedAt: new Date().toISOString(),
      data: { status: "degraded", database: "unavailable", heartbeats: [] },
      meta: { serviceVersion: "node-3-v1" },
    });
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<void> {
  if (await handleMeasurementProvenanceApi(request, response, url)) return;
  if (await handleComparisonApi(request, response, url)) return;
  if (await handleMeasurementApi(request, response, url)) return;
  if (response.writableEnded) return;

  sendJson(response, 404, {
    apiVersion: "v1",
    generatedAt: new Date().toISOString(),
    data: null,
    error: { code: "NOT_FOUND", message: "Route not found" },
  });
}

export function createApiServer() {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/v1/health") {
      void health(response);
      return;
    }

    void routeRequest(request, response, url).catch(() => {
      if (response.writableEnded) return;
      sendJson(response, 500, {
        apiVersion: "v1",
        generatedAt: new Date().toISOString(),
        data: null,
        error: { code: "INTERNAL_ERROR", message: "Request failed" },
      });
    });
  });
}

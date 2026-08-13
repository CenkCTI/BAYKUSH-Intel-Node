import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleComparisonApi } from "../measurement/comparison-api.js";
import { handleMeasurementApi } from "../measurement/api.js";
import { handleMeasurementProvenanceApi } from "../measurement/provenance-api.js";
import { authenticate, configuredApiToken, isProtectedPath } from "./auth.js";
import { requestId, sendEnvelope, sendError } from "./http.js";
import { handleReadApi } from "./read-api.js";

async function health(response: ServerResponse, id: string): Promise<void> {
  sendEnvelope(response, 200, { status: "ok", apiVersion: "v1" }, id);
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  id: string,
): Promise<void> {
  if (await handleReadApi(request, response, url, id)) return;
  if (await handleMeasurementProvenanceApi(request, response, url)) return;
  if (await handleComparisonApi(request, response, url)) return;
  if (await handleMeasurementApi(request, response, url)) return;
  if (response.writableEnded) return;

  sendError(response, 404, "NOT_FOUND", "Route not found", id);
}

export function createApiServer(options: { apiToken?: string | null } = {}) {
  const apiToken = options.apiToken === undefined ? configuredApiToken() : configuredApiToken(options.apiToken ?? undefined);
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const id = requestId();
    if (request.method === "GET" && url.pathname === "/v1/health") {
      void health(response, id);
      return;
    }
    if (url.pathname === "/v1/health") { sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed", id); return; }
    if (isProtectedPath(url.pathname) && !authenticate(request, apiToken)) { sendError(response, 401, "UNAUTHORIZED", "Valid service credential required", id); return; }
    if (isProtectedPath(url.pathname) && request.method !== "GET") { sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed", id); return; }

    void routeRequest(request, response, url, id).catch(() => {
      if (response.writableEnded) return;
      sendError(response, 500, "INTERNAL_ERROR", "Request failed", id);
    });
  });
}

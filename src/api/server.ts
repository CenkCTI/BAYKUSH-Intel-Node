import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleComparisonApi } from "../measurement/comparison-api.js";
import { handleMeasurementApi } from "../measurement/api.js";
import { handleMeasurementProvenanceApi } from "../measurement/provenance-api.js";
import {
  authenticatePrincipal,
  configuredApiCredentials,
  legacyApiCredentials,
  principalHasScope,
  requiredScopeForPath,
  type ApiCredential,
} from "./auth.js";
import { applyApiSecurityHeaders, requestId, sendEnvelope, sendError } from "./http.js";
import { handleNode7ReadApi } from "./node7-read-api.js";
import { InMemoryApiRateLimiter } from "./rate-limit.js";
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
  if (await handleNode7ReadApi(request, response, url, id)) return;
  if (await handleReadApi(request, response, url, id)) return;
  if (await handleMeasurementProvenanceApi(request, response, url)) return;
  if (await handleComparisonApi(request, response, url)) return;
  if (await handleMeasurementApi(request, response, url)) return;
  if (response.writableEnded) return;

  sendError(response, 404, "NOT_FOUND", "Route not found", id);
}

function isControlledNode7RequestError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return [
    "Exact entity type/key required",
    "Related-record limit must be 1..100",
    "Lineage depth must be 1..3",
    "Lineage node limit must be 1..100",
  ].includes(error.message);
}

export interface ApiServerOptions {
  apiToken?: string | null;
  apiCredentials?: readonly ApiCredential[];
  rateLimiter?: InMemoryApiRateLimiter;
}

function credentialsForServer(options: ApiServerOptions): readonly ApiCredential[] {
  if (options.apiCredentials !== undefined) return options.apiCredentials;
  if (options.apiToken !== undefined) return legacyApiCredentials(options.apiToken);
  return configuredApiCredentials();
}

export function createApiServer(options: ApiServerOptions = {}) {
  const credentials = credentialsForServer(options);
  const rateLimiter = options.rateLimiter ?? new InMemoryApiRateLimiter();

  return createServer((request: IncomingMessage, response: ServerResponse) => {
    // Apply the Node API security boundary before any route-specific handler runs.
    // Some legacy measurement handlers emit responses through their own sendJson
    // helpers, so enforcing headers here guarantees consistent hardening across
    // successful, error, health and legacy response paths without relying on each
    // downstream handler to remember the policy independently.
    applyApiSecurityHeaders(response);

    const url = new URL(request.url ?? "/", "http://localhost");
    const id = requestId();

    if (request.method === "GET" && url.pathname === "/v1/health") {
      void health(response, id);
      return;
    }
    if (url.pathname === "/v1/health") {
      sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed", id);
      return;
    }

    const requiredScope = requiredScopeForPath(url.pathname);
    if (requiredScope !== null) {
      const principal = authenticatePrincipal(request, credentials);
      if (!principal) {
        sendError(response, 401, "UNAUTHORIZED", "Valid service credential required", id);
        return;
      }
      if (!principalHasScope(principal, requiredScope)) {
        sendError(response, 403, "FORBIDDEN", "Service credential is not authorized for this endpoint", id);
        return;
      }
      if (request.method !== "GET") {
        sendError(response, 405, "METHOD_NOT_ALLOWED", "Method not allowed", id);
        return;
      }

      const decision = rateLimiter.consume(principal.id, url.pathname);
      response.setHeader("x-ratelimit-limit", String(decision.limit));
      response.setHeader("x-ratelimit-remaining", String(decision.remaining));
      if (!decision.allowed) {
        response.setHeader("retry-after", String(decision.retryAfterSeconds));
        sendError(response, 429, "RATE_LIMITED", "Service credential rate limit exceeded", id);
        return;
      }
    }

    void routeRequest(request, response, url, id).catch((error: unknown) => {
      if (response.writableEnded) return;
      if (isControlledNode7RequestError(error)) {
        sendError(response, 400, "INVALID_REQUEST", error.message, id);
        return;
      }
      sendError(response, 500, "INTERNAL_ERROR", "Request failed", id);
    });
  });
}

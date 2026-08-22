import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

export type ApiErrorCode = "UNAUTHORIZED" | "FORBIDDEN" | "RATE_LIMITED" | "INVALID_REQUEST" | "UNSUPPORTED_MEASUREMENT" |
  "UNSUPPORTED_DIMENSION" | "RANGE_TOO_LARGE" | "POINT_LIMIT_EXCEEDED" | "NOT_FOUND" |
  "DEPENDENCY_UNAVAILABLE" | "METHOD_NOT_ALLOWED" | "INTERNAL_ERROR";

export function requestId(): string { return randomUUID(); }

export function applyApiSecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("cross-origin-resource-policy", "same-site");
}

export function sendEnvelope(response: ServerResponse, status: number, data: unknown, requestIdValue: string, meta: Record<string, unknown> = {}): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", requestIdValue);
  applyApiSecurityHeaders(response);
  response.end(JSON.stringify({ apiVersion: "v1", generatedAt: new Date().toISOString(), data, meta: { requestId: requestIdValue, ...meta } }));
}

export function sendError(response: ServerResponse, status: number, code: ApiErrorCode, message: string, requestIdValue: string): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-request-id", requestIdValue);
  applyApiSecurityHeaders(response);
  response.end(JSON.stringify({ apiVersion: "v1", generatedAt: new Date().toISOString(), data: null, meta: { requestId: requestIdValue }, error: { code, message } }));
}

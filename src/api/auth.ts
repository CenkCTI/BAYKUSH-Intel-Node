import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const MINIMUM_API_TOKEN_BYTES = 32;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function configuredApiToken(value = process.env.BAYKUSH_NODE_API_TOKEN): string | null {
  const token = value?.trim();
  return token && Buffer.byteLength(token, "utf8") >= MINIMUM_API_TOKEN_BYTES ? token : null;
}

export function bearerToken(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  if (!value) return null;
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match?.[1] ?? null;
}

export function authenticate(request: IncomingMessage, expectedToken: string | null): boolean {
  const supplied = bearerToken(request);
  if (!expectedToken || !supplied) return false;
  return timingSafeEqual(digest(supplied), digest(expectedToken));
}

export function isProtectedPath(pathname: string): boolean {
  return pathname === "/v1/sources" || pathname.startsWith("/v1/sources/") || pathname.startsWith("/v1/techint/");
}

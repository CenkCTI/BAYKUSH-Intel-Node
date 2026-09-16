import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { resolveSecret } from "../security/secrets.js";

export const MINIMUM_API_TOKEN_BYTES = 32;
export const API_CREDENTIAL_SCOPES = ["techint:read", "sources:read", "ops:read"] as const;
export type ApiCredentialScope = (typeof API_CREDENTIAL_SCOPES)[number];

export interface ApiCredential {
  id: string;
  token: string;
  scopes: readonly ApiCredentialScope[];
}

export interface ApiPrincipal {
  id: string;
  scopes: readonly ApiCredentialScope[];
}

const credentialSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  token: z.string().refine(
    (value) => Buffer.byteLength(value, "utf8") >= MINIMUM_API_TOKEN_BYTES,
    `token must contain at least ${MINIMUM_API_TOKEN_BYTES} UTF-8 bytes`,
  ).refine((value) => Buffer.byteLength(value, "utf8") <= 4096, "token is too large"),
  scopes: z.array(z.enum(API_CREDENTIAL_SCOPES)).min(1).max(API_CREDENTIAL_SCOPES.length),
}).strict();

const registrySchema = z.object({
  credentials: z.array(credentialSchema).min(1).max(16),
}).strict();

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validateRegistry(credentials: readonly ApiCredential[]): ApiCredential[] {
  const ids = new Set<string>();
  return credentials.map((credential) => {
    if (ids.has(credential.id)) throw new Error(`Duplicate API credential id: ${credential.id}`);
    ids.add(credential.id);
    return Object.freeze({ ...credential, scopes: Object.freeze([...new Set(credential.scopes)]) });
  });
}

export function configuredApiToken(value = process.env.BAYKUSH_NODE_API_TOKEN): string | null {
  const token = value?.trim();
  return token && Buffer.byteLength(token, "utf8") >= MINIMUM_API_TOKEN_BYTES ? token : null;
}

export function legacyApiCredentials(value: string | null | undefined): ApiCredential[] {
  const token = configuredApiToken(value ?? undefined);
  if (!token) return [];
  return [{
    id: "legacy-citem",
    token,
    scopes: ["techint:read", "sources:read"],
  }];
}

export function configuredApiCredentials(env: NodeJS.ProcessEnv = process.env): ApiCredential[] {
  const registryRaw = resolveSecret(env, "BAYKUSH_NODE_API_CREDENTIALS", {
    fileEnvName: "BAYKUSH_NODE_API_CREDENTIALS_FILE",
    maxBytes: 64 * 1024,
  });
  const legacyToken = resolveSecret(env, "BAYKUSH_NODE_API_TOKEN", {
    fileEnvName: "BAYKUSH_NODE_API_TOKEN_FILE",
    maxBytes: 8 * 1024,
  });

  if (registryRaw !== undefined && legacyToken !== undefined) {
    throw new Error("BAYKUSH_NODE_API_CREDENTIALS_FILE and legacy API token configuration are mutually exclusive");
  }

  if (registryRaw !== undefined) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(registryRaw);
    } catch {
      throw new Error("BAYKUSH_NODE_API_CREDENTIALS_FILE must contain valid JSON");
    }
    return validateRegistry(registrySchema.parse(decoded).credentials);
  }

  return legacyApiCredentials(legacyToken);
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

export function authenticatePrincipal(
  request: IncomingMessage,
  credentials: readonly ApiCredential[],
): ApiPrincipal | null {
  const supplied = bearerToken(request);
  if (!supplied || credentials.length === 0) return null;

  const suppliedDigest = digest(supplied);
  let matched: ApiCredential | null = null;
  for (const credential of credentials) {
    const equal = timingSafeEqual(suppliedDigest, digest(credential.token));
    if (equal && matched === null) matched = credential;
  }

  return matched ? { id: matched.id, scopes: matched.scopes } : null;
}

export function requiredScopeForPath(pathname: string): ApiCredentialScope | null {
  if (pathname === "/v1/sources" || pathname.startsWith("/v1/sources/")) return "sources:read";
  if (pathname.startsWith("/v1/techint/")) return "techint:read";
  if (pathname.startsWith("/v1/ops/")) return "ops:read";
  return null;
}

export function principalHasScope(principal: ApiPrincipal, scope: ApiCredentialScope): boolean {
  return principal.scopes.includes(scope);
}

export function isProtectedPath(pathname: string): boolean {
  return requiredScopeForPath(pathname) !== null;
}

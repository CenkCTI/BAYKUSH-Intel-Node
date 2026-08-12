import { createHash } from "node:crypto";
import { CollectionFailure } from "../runtime/failure.js";
import { parseRetryAfterSeconds } from "./source-http.js";

export interface ArtifactEndpointRule {
  hostname: string;
  path: RegExp;
}

export interface SourceArtifactRequest<T> {
  url: URL;
  allowedEndpoints: readonly ArtifactEndpointRule[];
  maxRedirects?: number;
  maxCompressedBytes: number;
  timeoutMs: number;
  acceptedContentTypes?: readonly string[];
  headers?: Readonly<Record<string, string>>;
  redactValues?: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  consume(input: {
    stream: AsyncIterable<Buffer>;
    finalUrl: URL;
    contentType: string | null;
  }): Promise<T>;
}

export interface SourceArtifactResponse<T> {
  status: number;
  finalUrl: string;
  redirectChain: readonly string[];
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
  compressedBytes: number;
  compressedSha256: string | null;
  value: T | null;
}

const SENSITIVE_REDIRECT_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "apikey",
  "api-key",
  "auth-key",
]);

function endpointAllowed(url: URL, rules: readonly ArtifactEndpointRule[]): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
  return rules.some((rule) => rule.hostname === url.hostname && rule.path.test(url.pathname));
}

function validateRequest(input: SourceArtifactRequest<unknown>): void {
  if (!endpointAllowed(input.url, input.allowedEndpoints)) {
    throw new CollectionFailure("SCHEMA_ERROR", "Artifact URL is outside the fixed provider endpoint allowlist", false);
  }
  if (!Number.isInteger(input.maxCompressedBytes) || input.maxCompressedBytes < 1) {
    throw new CollectionFailure("INTERNAL_ERROR", "Artifact compressed byte limit is invalid", false);
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new CollectionFailure("INTERNAL_ERROR", "Artifact request timeout is invalid", false);
  }
  const maxRedirects = input.maxRedirects ?? 3;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 10) {
    throw new CollectionFailure("INTERNAL_ERROR", "Artifact redirect limit is invalid", false);
  }
}

function providerDiagnostic(response: Response, redactValues: readonly string[] = []): string {
  let message = (response.headers.get("message") ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512);
  for (const secret of redactValues) {
    if (!secret) continue;
    message = message.split(secret).join("[REDACTED]");
  }
  return message;
}

function statusFailure(response: Response, redactValues: readonly string[] = []): CollectionFailure {
  const diagnostic = providerDiagnostic(response, redactValues);
  const suffix = diagnostic ? `: ${diagnostic}` : "";
  if (response.status === 401 || response.status === 403) {
    return new CollectionFailure("AUTHENTICATION_ERROR", `Source authentication was rejected${suffix}`, false);
  }
  if (response.status === 429) {
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
    return new CollectionFailure(
      "RATE_LIMITED",
      `Source rate limit was reached${suffix}`,
      true,
      retryAfterSeconds === undefined ? {} : { retryAfterSeconds },
    );
  }
  if (response.status >= 500) {
    return new CollectionFailure("PROVIDER_ERROR", `Source returned HTTP ${response.status}${suffix}`, true);
  }
  return new CollectionFailure("PROVIDER_ERROR", `Source returned HTTP ${response.status}${suffix}`, false);
}

function redirectedHeaders(headers: Readonly<Record<string, string>>, from: URL, to: URL): Record<string, string> {
  if (from.hostname === to.hostname) return { ...headers };
  const output: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!SENSITIVE_REDIRECT_HEADERS.has(name.toLowerCase())) output[name] = value;
  }
  return output;
}

function normalizedMediaType(value: string | null): string | null {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

export async function fetchBoundedArtifact<T>(input: SourceArtifactRequest<T>): Promise<SourceArtifactResponse<T>> {
  validateRequest(input as SourceArtifactRequest<unknown>);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxRedirects = input.maxRedirects ?? 3;
  const redirectChain: string[] = [];
  let currentUrl = new URL(input.url.toString());
  let headers: Record<string, string> = { ...(input.headers ?? {}) };

  try {
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      if (!endpointAllowed(currentUrl, input.allowedEndpoints)) {
        throw new CollectionFailure("SCHEMA_ERROR", "Artifact redirect left the provider endpoint allowlist", false);
      }

      let response: Response;
      try {
        response = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new CollectionFailure("TIMEOUT", "Artifact request exceeded its bounded timeout or was cancelled", true, { cause: error });
        }
        throw new CollectionFailure("TRANSPORT_ERROR", "Artifact transport failed", true, { cause: error });
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirectCount >= maxRedirects) {
          throw new CollectionFailure("PROVIDER_ERROR", "Artifact redirect limit was exceeded", false);
        }
        const location = response.headers.get("location");
        if (!location) throw new CollectionFailure("PROVIDER_ERROR", "Artifact redirect omitted Location", false);
        const nextUrl = new URL(location, currentUrl);
        if (!endpointAllowed(nextUrl, input.allowedEndpoints)) {
          throw new CollectionFailure("SCHEMA_ERROR", "Artifact redirect target is not allowlisted", false);
        }
        headers = redirectedHeaders(headers, currentUrl, nextUrl);
        redirectChain.push(nextUrl.toString());
        currentUrl = nextUrl;
        continue;
      }

      if (response.status === 304) {
        return {
          status: 304,
          finalUrl: currentUrl.toString(),
          redirectChain,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          contentType: response.headers.get("content-type"),
          compressedBytes: 0,
          compressedSha256: null,
          value: null,
        };
      }

      if (response.status !== 200) throw statusFailure(response, input.redactValues);

      const mediaType = normalizedMediaType(response.headers.get("content-type"));
      if (mediaType && input.acceptedContentTypes && !input.acceptedContentTypes.includes(mediaType)) {
        throw new CollectionFailure("PROVIDER_ERROR", "Artifact returned an unexpected content type", true);
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        const declared = Number(contentLength);
        if (Number.isFinite(declared) && declared > input.maxCompressedBytes) {
          throw new CollectionFailure(
            "PAYLOAD_LIMIT_EXCEEDED",
            `Artifact response exceeds ${input.maxCompressedBytes} compressed bytes`,
            false,
          );
        }
      }
      if (!response.body) throw new CollectionFailure("PROVIDER_ERROR", "Artifact response had no body", true);

      const hash = createHash("sha256");
      let compressedBytes = 0;
      let fullyConsumed = false;
      const reader = response.body.getReader();
      const stream = (async function* boundedStream(): AsyncGenerator<Buffer> {
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) {
              fullyConsumed = true;
              return;
            }
            if (!next.value) continue;
            compressedBytes += next.value.byteLength;
            if (compressedBytes > input.maxCompressedBytes) {
              await reader.cancel();
              throw new CollectionFailure(
                "PAYLOAD_LIMIT_EXCEEDED",
                `Artifact response exceeds ${input.maxCompressedBytes} compressed bytes`,
                false,
              );
            }
            const chunk = Buffer.from(next.value);
            hash.update(chunk);
            yield chunk;
          }
        } finally {
          reader.releaseLock();
        }
      })();

      let value: T;
      try {
        value = await input.consume({ stream, finalUrl: currentUrl, contentType: response.headers.get("content-type") });
      } finally {
        if (!fullyConsumed) {
          try { await reader.cancel(); } catch { /* best-effort cancellation */ }
        }
      }
      if (!fullyConsumed) {
        throw new CollectionFailure("PROVIDER_ERROR", "Artifact consumer did not consume the complete response body", false);
      }

      return {
        status: 200,
        finalUrl: currentUrl.toString(),
        redirectChain,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        contentType: response.headers.get("content-type"),
        compressedBytes,
        compressedSha256: hash.digest("hex"),
        value,
      };
    }
    throw new CollectionFailure("INTERNAL_ERROR", "Artifact redirect loop terminated unexpectedly", false);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

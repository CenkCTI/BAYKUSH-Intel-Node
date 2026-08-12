import { CollectionFailure } from "../runtime/failure.js";

export type SourceHttpMethod = "GET" | "POST";

export interface SourceHttpRequest {
  url: URL;
  allowedHost: string;
  allowedPath: string;
  maxBytes: number;
  timeoutMs: number;
  method?: SourceHttpMethod;
  body?: string;
  maxRequestBytes?: number;
  acceptedStatuses?: readonly number[];
  headers?: Readonly<Record<string, string>>;
  /** Exact secret values that must be redacted if a provider echoes them in diagnostic headers. */
  redactValues?: readonly string[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface SourceHttpResponse {
  status: number;
  bytes: Buffer;
  etag: string | null;
  lastModified: string | null;
  contentType: string | null;
}

export interface SourceJsonResponse extends SourceHttpResponse {
  json: unknown | null;
}

export function parseRetryAfterSeconds(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1, Math.min(86_400, Math.ceil(seconds)));
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  const delta = Math.ceil((dateMs - nowMs) / 1_000);
  return Math.max(1, Math.min(86_400, delta));
}

function validateRequest(input: SourceHttpRequest): void {
  if (input.url.protocol !== "https:") {
    throw new CollectionFailure("SCHEMA_ERROR", "Source URL must use HTTPS", false);
  }
  if (input.url.username || input.url.password) {
    throw new CollectionFailure("SCHEMA_ERROR", "Source URL must not contain credentials", false);
  }
  if (input.url.hostname !== input.allowedHost || input.url.pathname !== input.allowedPath) {
    throw new CollectionFailure("SCHEMA_ERROR", "Source URL is outside the fixed provider endpoint", false);
  }
  if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new CollectionFailure("INTERNAL_ERROR", "Source response byte limit is invalid", false);
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
    throw new CollectionFailure("INTERNAL_ERROR", "Source request timeout is invalid", false);
  }

  const method = input.method ?? "GET";
  if (method === "GET" && input.body !== undefined) {
    throw new CollectionFailure("SCHEMA_ERROR", "GET source requests must not include a request body", false);
  }
  if (input.maxRequestBytes !== undefined && (!Number.isInteger(input.maxRequestBytes) || input.maxRequestBytes < 1)) {
    throw new CollectionFailure("INTERNAL_ERROR", "Source request byte limit is invalid", false);
  }
  if (input.body !== undefined) {
    const maxRequestBytes = input.maxRequestBytes ?? 16 * 1024;
    if (Buffer.byteLength(input.body, "utf8") > maxRequestBytes) {
      throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `Source request exceeds ${maxRequestBytes} bytes`, false);
    }
  }
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `Source response exceeds ${maxBytes} bytes`, false);
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `Source response exceeds ${maxBytes} bytes`, false);
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
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
    return new CollectionFailure("RATE_LIMITED", `Source rate limit was reached${suffix}`, true,
      retryAfterSeconds === undefined ? {} : { retryAfterSeconds });
  }
  if (response.status >= 500) {
    return new CollectionFailure("PROVIDER_ERROR", `Source returned HTTP ${response.status}${suffix}`, true);
  }
  if (response.status >= 300 && response.status < 400) {
    return new CollectionFailure("PROVIDER_ERROR", `Source redirects are not followed automatically${suffix}`, false);
  }
  return new CollectionFailure("PROVIDER_ERROR", `Source returned HTTP ${response.status}${suffix}`, false);
}

export async function fetchBoundedSource(input: SourceHttpRequest): Promise<SourceHttpResponse> {
  validateRequest(input);
  const accepted = new Set(input.acceptedStatuses ?? [200]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  const fetchImpl = input.fetchImpl ?? fetch;

  try {
    let response: Response;
    try {
      const init: RequestInit = {
        method: input.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
      };
      if (input.headers) init.headers = { ...input.headers };
      if (input.body !== undefined) init.body = input.body;
      response = await fetchImpl(input.url, init);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CollectionFailure("TIMEOUT", "Source request exceeded its bounded timeout or was cancelled", true, { cause: error });
      }
      throw new CollectionFailure("TRANSPORT_ERROR", "Source transport failed", true, { cause: error });
    }

    if (!accepted.has(response.status)) throw statusFailure(response, input.redactValues);
    const bytes = response.status === 304 ? Buffer.alloc(0) : await readBoundedBody(response, input.maxBytes);
    return {
      status: response.status,
      bytes,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentType: response.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

export async function fetchBoundedJson(input: SourceHttpRequest): Promise<SourceJsonResponse> {
  const response = await fetchBoundedSource(input);
  if (response.status === 304 || response.bytes.length === 0) return { ...response, json: null };
  const mediaType = response.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType && mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new CollectionFailure("PROVIDER_ERROR", "Source returned an unexpected content type", true);
  }
  try {
    return { ...response, json: JSON.parse(response.bytes.toString("utf8")) as unknown };
  } catch (error) {
    throw new CollectionFailure("PROVIDER_ERROR", "Source returned invalid JSON", true, { cause: error });
  }
}

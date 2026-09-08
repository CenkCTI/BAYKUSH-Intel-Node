import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

const allowedEndpoints = new Set(["/v1/techint/measurement-catalog", "/v1/sources", "/v1/ops/health"]);
const finite = (value) => Number.isFinite(value);
function requireValue(condition, message) { if (!condition) throw new Error(message); }

export async function runLoadAcceptance(options) {
  const { baseUrl, token, requests, concurrency, timeoutMs, p95LimitMs, maxErrorRate, endpoints, fetchImpl = globalThis.fetch } = options;
  requireValue(/^https:\/\//u.test(baseUrl), "NODE8_LOAD_BASE_URL must be an HTTPS production-like endpoint");
  requireValue(Buffer.byteLength(token, "utf8") >= 32, "load credential is missing or too short");
  requireValue(Number.isInteger(requests) && requests >= 1 && requests <= 10_000, "NODE8_LOAD_REQUESTS must be 1..10000");
  requireValue(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 100, "NODE8_LOAD_CONCURRENCY must be 1..100");
  requireValue(Number.isInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 60_000, "NODE8_LOAD_TIMEOUT_MS must be 100..60000");
  requireValue(finite(p95LimitMs) && p95LimitMs > 0, "NODE8_LOAD_P95_MS must be positive");
  requireValue(finite(maxErrorRate) && maxErrorRate >= 0 && maxErrorRate <= 1, "NODE8_LOAD_MAX_ERROR_RATE must be 0..1");
  requireValue(endpoints.length >= 1 && endpoints.length <= 3 && endpoints.every((endpoint) => allowedEndpoints.has(endpoint)), "load endpoints must be approved read-only paths");

  const timings = [];
  const statusCounts = new Map();
  const errorCounts = { timeout: 0, transport: 0, http: 0 };
  let cursor = 0;
  let successfulRequests = 0;
  const startedAt = globalThis.performance.now();
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= requests) return;
      const started = globalThis.performance.now();
      let status = 0;
      try {
        const response = await fetchImpl(`${baseUrl}${endpoints[index % endpoints.length]}`, {
          method: "GET", redirect: "manual", headers: { authorization: `Bearer ${token}` }, signal: globalThis.AbortSignal.timeout(timeoutMs),
        });
        status = response.status;
        await response.arrayBuffer();
        if (response.ok) successfulRequests += 1;
        else errorCounts.http += 1;
      } catch (error) {
        if (error?.name === "TimeoutError" || error?.name === "AbortError") errorCounts.timeout += 1;
        else errorCounts.transport += 1;
      } finally {
        timings.push(globalThis.performance.now() - started);
        statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));
  const durationMs = Math.round((globalThis.performance.now() - startedAt) * 100) / 100;
  timings.sort((a, b) => a - b);
  const percentile = (p) => Math.round(timings[Math.min(timings.length - 1, Math.max(0, Math.ceil(p * timings.length) - 1))] * 100) / 100;
  const failedRequests = requests - successfulRequests;
  const errorRate = failedRequests / requests;
  const latencyMs = { p50: percentile(0.50), p95: percentile(0.95), p99: percentile(0.99) };
  const accepted = errorRate <= maxErrorRate && latencyMs.p95 <= p95LimitMs;
  return {
    schemaVersion: "NODE8_LOAD_ACCEPTANCE_V1", accepted, observedAt: new Date().toISOString(),
    totalRequests: requests, successfulRequests, failedRequests, statusCounts: Object.fromEntries([...statusCounts].sort((a, b) => a[0] - b[0])),
    errorCounts, concurrency, durationMs, requestTimeoutMs: timeoutMs, endpoints, latencyMs,
    thresholds: { p95MaxMs: p95LimitMs, maxErrorRate, classification: "NODE-8 engineering acceptance thresholds; not an SLA, intelligence-quality metric, or coverage claim." },
    errorRate, containsCredential: false,
    semantics: { readOnly: true, performanceRepresents: "Bounded production-read API responsiveness for this run.", performanceDoesNotRepresent: "Threat level, reporting or attack volume, collection completeness, or public SLA." },
  };
}

export async function runCli(env = process.env) {
  const tokenFile = env.NODE8_LOAD_TOKEN_FILE;
  requireValue(Boolean(tokenFile), "NODE8_LOAD_TOKEN_FILE is required");
  const token = (await readFile(tokenFile, "utf8")).trim();
  const result = await runLoadAcceptance({
    baseUrl: (env.NODE8_LOAD_BASE_URL ?? "").replace(/\/$/u, ""), token,
    requests: Number(env.NODE8_LOAD_REQUESTS ?? "100"), concurrency: Number(env.NODE8_LOAD_CONCURRENCY ?? "5"),
    timeoutMs: Number(env.NODE8_LOAD_TIMEOUT_MS ?? "15000"), p95LimitMs: Number(env.NODE8_LOAD_P95_MS ?? "2000"),
    maxErrorRate: Number(env.NODE8_LOAD_MAX_ERROR_RATE ?? "0.01"),
    endpoints: (env.NODE8_LOAD_ENDPOINTS ?? "/v1/techint/measurement-catalog,/v1/sources").split(",").map((value) => value.trim()).filter(Boolean),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.accepted ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stdout.write(`${JSON.stringify({ schemaVersion: "NODE8_LOAD_ACCEPTANCE_V1", accepted: false, error: error instanceof Error ? error.message : String(error), containsCredential: false }, null, 2)}\n`);
    process.exitCode = 1;
  });
}

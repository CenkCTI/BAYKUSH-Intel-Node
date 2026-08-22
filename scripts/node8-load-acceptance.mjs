import { readFile } from "node:fs/promises";
import process from "node:process";

const baseUrl = (process.env.NODE8_LOAD_BASE_URL ?? "").replace(/\/$/u, "");
const tokenFile = process.env.NODE8_LOAD_TOKEN_FILE;
const requests = Number(process.env.NODE8_LOAD_REQUESTS ?? "100");
const concurrency = Number(process.env.NODE8_LOAD_CONCURRENCY ?? "5");
const p95LimitMs = Number(process.env.NODE8_LOAD_P95_MS ?? "2000");
const maxErrorRate = Number(process.env.NODE8_LOAD_MAX_ERROR_RATE ?? "0.01");
const endpoints = (process.env.NODE8_LOAD_ENDPOINTS ?? "/v1/techint/measurement-catalog,/v1/sources")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(/^https:\/\//u.test(baseUrl), "NODE8_LOAD_BASE_URL must be an HTTPS production-like endpoint");
assert(tokenFile, "NODE8_LOAD_TOKEN_FILE is required");
assert(Number.isInteger(requests) && requests >= 1 && requests <= 10_000, "NODE8_LOAD_REQUESTS must be 1..10000");
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 100, "NODE8_LOAD_CONCURRENCY must be 1..100");
assert(endpoints.length >= 1 && endpoints.length <= 20, "NODE8_LOAD_ENDPOINTS must contain 1..20 endpoints");
for (const endpoint of endpoints) assert(endpoint.startsWith("/v1/"), `invalid load endpoint ${endpoint}`);

const token = (await readFile(tokenFile, "utf8")).trim();
assert(Buffer.byteLength(token, "utf8") >= 32, "load credential is missing or too short");

const timings = [];
const statusCounts = new Map();
let cursor = 0;
let failures = 0;

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= requests) return;
    const endpoint = endpoints[index % endpoints.length];
    const started = performance.now();
    let status = 0;
    try {
      const response = await fetch(`${baseUrl}${endpoint}`, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      status = response.status;
      await response.arrayBuffer();
      if (!response.ok) failures += 1;
    } catch {
      failures += 1;
    } finally {
      timings.push(performance.now() - started);
      statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, requests) }, () => worker()));

timings.sort((a, b) => a - b);
const percentile = (p) => {
  if (timings.length === 0) return null;
  const index = Math.min(timings.length - 1, Math.max(0, Math.ceil(p * timings.length) - 1));
  return Math.round(timings[index] * 100) / 100;
};
const errorRate = failures / requests;
const p50 = percentile(0.50);
const p95 = percentile(0.95);
const p99 = percentile(0.99);
const accepted = errorRate <= maxErrorRate && p95 !== null && p95 <= p95LimitMs;

const evidence = {
  schemaVersion: "NODE8_LOAD_ACCEPTANCE_V1",
  accepted,
  observedAt: new Date().toISOString(),
  requests,
  concurrency,
  endpoints,
  latencyMs: { p50, p95, p99 },
  thresholds: { p95MaxMs: p95LimitMs, maxErrorRate },
  errorRate,
  statusCounts: Object.fromEntries([...statusCounts.entries()].sort((a, b) => a[0] - b[0])),
  containsCredential: false,
  semantics: {
    performanceRepresents: "Bounded production-read API responsiveness under this acceptance workload.",
    performanceDoesNotRepresent: "Threat level, collection completeness, attack volume or a public SLA.",
  },
};

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
process.exitCode = accepted ? 0 : 1;

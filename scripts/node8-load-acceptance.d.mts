export interface Node8LoadOptions {
  baseUrl: string;
  token: string;
  requests: number;
  concurrency: number;
  timeoutMs: number;
  p95LimitMs: number;
  maxErrorRate: number;
  endpoints: string[];
  fetchImpl?: typeof fetch;
}

export interface Node8LoadResult {
  schemaVersion: "NODE8_LOAD_ACCEPTANCE_V1";
  accepted: boolean;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  errorCounts: { timeout: number; transport: number; http: number };
  latencyMs: { p50: number; p95: number; p99: number };
}

export function runLoadAcceptance(options: Node8LoadOptions): Promise<Node8LoadResult>;
export function runCli(env?: NodeJS.ProcessEnv): Promise<number>;

import type { IncomingMessage, ServerResponse } from "node:http";
import { comparePreviousPeriod } from "./comparison.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

export async function handleComparisonApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
): Promise<boolean> {
  if (request.method !== "GET" || url.pathname !== "/v1/techint/comparison") {
    return false;
  }

  const measurementKey = url.searchParams.get("measurementKey");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!measurementKey || !from || !to) {
    send(response, 400, {
      apiVersion: "v1",
      generatedAt: new Date().toISOString(),
      data: null,
      error: {
        code: "INVALID_REQUEST",
        message: "measurementKey, from and to are required",
      },
    });
    return true;
  }

  try {
    const data = await comparePreviousPeriod({ measurementKey, from, to });
    send(response, 200, {
      apiVersion: "v1",
      generatedAt: new Date().toISOString(),
      data,
      meta: { comparison: "equal-length previous period" },
    });
  } catch (error) {
    send(response, 400, {
      apiVersion: "v1",
      generatedAt: new Date().toISOString(),
      data: null,
      error: {
        code: "INVALID_REQUEST",
        message: error instanceof Error ? error.message : "Comparison failed",
      },
    });
  }

  return true;
}

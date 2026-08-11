import { createHash } from "node:crypto";
import { CollectionFailure } from "./failure.js";

export interface PreparedRawRecord {
  sourceRecordId: string;
  payload: unknown;
  payloadJson: string;
  payloadSha256: string;
  payloadBytes: number;
  publishedAt: string | null;
  effectiveAt: string | null;
  upstreamUpdatedAt: string | null;
  sourceUrl: string | null;
  sourceSchemaVersion: string | null;
}

function normalizeJson(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CollectionFailure("SCHEMA_ERROR", "Raw payload contains a non-finite number", false);
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CollectionFailure("SCHEMA_ERROR", "Raw payload must contain only JSON-compatible objects", false);
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") {
        throw new CollectionFailure("SCHEMA_ERROR", `Raw payload field ${key} is not JSON-compatible`, false);
      }
      output[key] = normalizeJson(child);
    }
    return output;
  }
  throw new CollectionFailure("SCHEMA_ERROR", "Raw payload is not JSON-compatible", false);
}

export function canonicalJsonStringify(payload: unknown): string {
  return JSON.stringify(normalizeJson(payload));
}

export function prepareRawRecord(input: Omit<PreparedRawRecord, "payloadJson" | "payloadSha256" | "payloadBytes">, maxBytes: number): PreparedRawRecord {
  const sourceRecordId = input.sourceRecordId.trim();
  if (!sourceRecordId || sourceRecordId.length > 512) {
    throw new CollectionFailure("SCHEMA_ERROR", "Source record identity is missing or too long", false);
  }
  const payloadJson = canonicalJsonStringify(input.payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  if (payloadBytes > maxBytes) {
    throw new CollectionFailure("PAYLOAD_LIMIT_EXCEEDED", `Raw record exceeds ${maxBytes} bytes`, false);
  }
  return {
    ...input,
    sourceRecordId,
    payloadJson,
    payloadBytes,
    payloadSha256: createHash("sha256").update(payloadJson).digest("hex"),
  };
}

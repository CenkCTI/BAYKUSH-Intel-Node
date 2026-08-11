import { describe, expect, it } from "vitest";
import { CollectionFailure } from "../src/runtime/failure.js";
import { canonicalJsonStringify, prepareRawRecord } from "../src/runtime/raw-record.js";

describe("raw source record preparation", () => {
  it("hashes equivalent JSON objects deterministically", () => {
    const left = canonicalJsonStringify({ b: 2, a: { y: 2, x: 1 } });
    const right = canonicalJsonStringify({ a: { x: 1, y: 2 }, b: 2 });
    expect(left).toBe(right);

    const first = prepareRawRecord({
      sourceRecordId: "record-1",
      payload: { b: 2, a: 1 },
      publishedAt: null,
      effectiveAt: null,
      upstreamUpdatedAt: null,
      sourceUrl: null,
      sourceSchemaVersion: null,
    }, 10_000);
    const second = prepareRawRecord({
      sourceRecordId: "record-1",
      payload: { a: 1, b: 2 },
      publishedAt: null,
      effectiveAt: null,
      upstreamUpdatedAt: null,
      sourceUrl: null,
      sourceSchemaVersion: null,
    }, 10_000);
    expect(first.payloadSha256).toBe(second.payloadSha256);
  });

  it("rejects oversized payloads without converting them to partial truth", () => {
    expect(() => prepareRawRecord({
      sourceRecordId: "record-2",
      payload: { value: "x".repeat(100) },
      publishedAt: null,
      effectiveAt: null,
      upstreamUpdatedAt: null,
      sourceUrl: null,
      sourceSchemaVersion: null,
    }, 10)).toThrowError(CollectionFailure);
  });

  it("rejects non-JSON values", () => {
    expect(() => canonicalJsonStringify({ value: BigInt(1) })).toThrowError(CollectionFailure);
  });
});

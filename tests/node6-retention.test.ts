import { describe, expect, it, vi } from "vitest";
import { purgeExpiredStreamPayloadsWithClient } from "../src/stream/retention.js";

describe("NODE-6 raw stream retention", () => {
  it("deletes only bounded expired payload rows and preserves durable relations", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql.replace(/\s+/g, " ").trim());
      if (sql.includes("RETURNING id")) return { rows: [{ id: "retention-run" }], rowCount: 1 };
      if (sql.includes("DELETE FROM stream_segment_payloads")) return { rows: [], rowCount: 2 };
      return { rows: [], rowCount: 1 };
    });

    await expect(purgeExpiredStreamPayloadsWithClient({ query } as never, 2)).resolves.toBe(2);

    expect(queries.some((sql) => sql.includes("expires_at<now()") && sql.includes("LIMIT $1"))).toBe(true);
    expect(queries.some((sql) => /DELETE FROM stream_segment_manifests/i.test(sql))).toBe(false);
    expect(queries.some((sql) => /DELETE FROM routing_/i.test(sql))).toBe(false);
    expect(queries.some((sql) => /DELETE FROM measurement_/i.test(sql))).toBe(false);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("rejects an unbounded purge request before issuing SQL", async () => {
    const query = vi.fn();
    await expect(purgeExpiredStreamPayloadsWithClient({ query } as never, 100_001)).rejects.toThrow(
      "Invalid retention batch limit",
    );
    expect(query).not.toHaveBeenCalled();
  });
});

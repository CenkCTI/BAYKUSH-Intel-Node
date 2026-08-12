import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { exportNodeParitySnapshot } from "../src/node2g/node-projection.js";

describe("NODE-2G Node parity projection", () => {
  it("normalizes CISA human-readable display whitespace without changing raw evidence", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "source-1",
          source_class: "EXPLOITED_VULNERABILITY_CATALOG",
          observation_basis: "PUBLISHED",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          source_record_id: "CVE-2026-1234",
          payload: {
            cveID: "CVE-2026-1234",
            dateAdded: "2026-08-11",
            dueDate: "2026-09-01",
            vendorProject: "  Array   Networks ",
            product: "Commerce and\u202fMagento ",
            knownRansomwareCampaignUse: "Unknown",
          },
          published_at: null,
          effective_at: null,
          upstream_updated_at: null,
        }],
      });
    const pool = { query } as unknown as Pool;

    const snapshot = await exportNodeParitySnapshot(pool, "CISA_KEV", {
      upstreamSnapshotId: "CISA:2026.08.11",
      capturedAt: "2026-08-12T14:00:00.000Z",
    });

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]?.facts.vendor).toBe("Array Networks");
    expect(snapshot.records[0]?.facts.product).toBe("Commerce and Magento");
    expect(snapshot.records[0]?.facts.cve).toBe("CVE-2026-1234");
    expect(snapshot.records[0]?.facts.dateAdded).toBe("2026-08-11");
    expect(snapshot.records[0]?.facts.dueDate).toBe("2026-09-01");
  });

  it("filters NVD parity records to one explicit last-modified window", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "source-nvd",
          source_class: "VULNERABILITY_DATABASE",
          observation_basis: "ENRICHED",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          source_record_id: "CVE-2026-4321",
          payload: {
            id: "CVE-2026-4321",
            published: "2026-08-01T00:00:00.000Z",
            lastModified: "2026-08-12T13:30:00.000Z",
            vulnStatus: "Analyzed",
          },
          published_at: new Date("2026-08-01T00:00:00.000Z"),
          effective_at: new Date("2026-08-12T13:30:00.000Z"),
          upstream_updated_at: new Date("2026-08-12T13:30:00.000Z"),
        }],
      });
    const pool = { query } as unknown as Pool;

    const snapshot = await exportNodeParitySnapshot(pool, "NVD_CVE", {
      capturedAt: "2026-08-12T14:00:00.000Z",
      windowStart: "2026-08-12T13:00:00Z",
      windowEnd: "2026-08-12T14:00:00Z",
    });

    expect(snapshot.window).toEqual({
      start: "2026-08-12T13:00:00.000Z",
      end: "2026-08-12T14:00:00.000Z",
    });
    expect(snapshot.records).toHaveLength(1);
    expect(query.mock.calls[1]?.[1]).toEqual([
      "source-nvd",
      [],
      "2026-08-12T13:00:00.000Z",
      "2026-08-12T14:00:00.000Z",
    ]);
    expect(String(query.mock.calls[1]?.[0])).toContain("upstream_updated_at >= $3::timestamptz");
    expect(String(query.mock.calls[1]?.[0])).toContain("upstream_updated_at <= $4::timestamptz");
  });

  it("rejects explicit parity windows for sources other than NVD", async () => {
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: "source-1",
        source_class: "EXPLOITED_VULNERABILITY_CATALOG",
        observation_basis: "PUBLISHED",
      }],
    });
    const pool = { query } as unknown as Pool;

    await expect(exportNodeParitySnapshot(pool, "CISA_KEV", {
      windowStart: "2026-08-12T13:00:00Z",
      windowEnd: "2026-08-12T14:00:00Z",
    })).rejects.toThrow("currently supported only for NVD_CVE");
  });
});

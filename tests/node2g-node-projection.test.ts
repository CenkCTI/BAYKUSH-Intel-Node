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
});

import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { exportNodeParitySnapshot } from "../src/node2g/node-projection.js";

const sharedNvdCommonPayload = {
  id: "CVE-2099-13001",
  sourceIdentifier: "example@example.test",
  published: "2099-01-01T00:00:00.000Z",
  lastModified: "2099-01-02T00:00:00.000Z",
  vulnStatus: "Analyzed",
  descriptions: [{ lang: "en", value: "NVD diagnostic fixture." }],
  metrics: {},
  weaknesses: [],
  references: [],
  configurations: [],
};

const sharedThreatFoxCommonPayload = {
  kind: "THREATFOX_IOC",
  source: {
    id: "123456",
    ioc: "192.0.2.10:443",
    threat_type: "botnet_cc",
    threat_type_desc: "Botnet command and control",
    ioc_type: "ip:port",
    ioc_type_desc: "ip:port",
    malware: "win.example",
    malware_printable: "Example Malware",
    malware_alias: null,
    malware_malpedia: "https://malpedia.caad.fkie.fraunhofer.de/details/win.example",
    confidence_level: 75,
    first_seen: "2099-01-01 00:00:00 UTC",
    last_seen: "2099-01-02 00:00:00 UTC",
    reporter: "fixture",
    reference: null,
    tags: ["test"],
  },
};

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

  it("preserves NODE-2G critical source facts from the shared NVD common payload", async () => {
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
          source_record_id: sharedNvdCommonPayload.id,
          payload: sharedNvdCommonPayload,
          published_at: new Date(sharedNvdCommonPayload.published),
          effective_at: new Date(sharedNvdCommonPayload.lastModified),
          upstream_updated_at: new Date(sharedNvdCommonPayload.lastModified),
        }],
      });
    const pool = { query } as unknown as Pool;

    const snapshot = await exportNodeParitySnapshot(pool, "NVD_CVE", {
      capturedAt: "2099-01-03T00:00:00.000Z",
    });

    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      sourceRecordId: "CVE-2099-13001",
      facts: {
        cve: "CVE-2099-13001",
        published: "2099-01-01T00:00:00.000Z",
        lastModified: "2099-01-02T00:00:00.000Z",
        vulnStatus: "Analyzed",
      },
    });
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

  it("projects shared ThreatFox provider facts and bounds live parity by provider first_seen", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "source-threatfox",
          source_class: "IOC_SHARING",
          observation_basis: "REPORTED",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          source_record_id: "123456",
          payload: sharedThreatFoxCommonPayload,
          published_at: null,
          effective_at: new Date("2099-01-01T00:00:00.000Z"),
          upstream_updated_at: null,
        }],
      });
    const pool = { query } as unknown as Pool;

    const snapshot = await exportNodeParitySnapshot(pool, "THREATFOX", {
      capturedAt: "2099-01-03T00:00:00.000Z",
      windowStart: "2098-12-31T23:30:00Z",
      windowEnd: "2099-01-01T00:30:00Z",
    });

    expect(snapshot.window).toEqual({
      start: "2098-12-31T23:30:00.000Z",
      end: "2099-01-01T00:30:00.000Z",
    });
    expect(snapshot.records).toHaveLength(1);
    expect(snapshot.records[0]).toMatchObject({
      sourceRecordId: "123456",
      subject: { kind: "INDICATOR", value: "192.0.2.10:443" },
      facts: {
        providerId: "123456",
        indicatorType: "ip:port",
        indicatorValue: "192.0.2.10:443",
        firstSeen: "2099-01-01T00:00:00.000Z",
        lastSeen: "2099-01-02T00:00:00.000Z",
        malwareFamily: "Example Malware",
        providerConfidence: 75,
      },
    });
    expect(query.mock.calls[1]?.[1]).toEqual([
      "source-threatfox",
      ["query-manifest"],
      "2098-12-31T23:30:00.000Z",
      "2099-01-01T00:30:00.000Z",
    ]);
    expect(String(query.mock.calls[1]?.[0])).toContain("effective_at >= $3::timestamptz");
    expect(String(query.mock.calls[1]?.[0])).toContain("effective_at <= $4::timestamptz");
    expect(String(query.mock.calls[1]?.[0])).not.toContain("upstream_updated_at >= $3::timestamptz");
  });

  it("does not reinterpret a ThreatFox Malpedia reference URL as a malware-family label", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "source-threatfox",
          source_class: "IOC_SHARING",
          observation_basis: "REPORTED",
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          source_record_id: "123457",
          payload: {
            kind: "THREATFOX_IOC",
            source: {
              ...sharedThreatFoxCommonPayload.source,
              id: "123457",
              ioc: "example.test",
              ioc_type: "domain",
              malware: null,
              malware_printable: null,
              malware_malpedia: "https://malpedia.caad.fkie.fraunhofer.de/details/example",
            },
          },
          published_at: null,
          effective_at: new Date("2099-01-01T00:00:00.000Z"),
          upstream_updated_at: null,
        }],
      });
    const pool = { query } as unknown as Pool;

    const snapshot = await exportNodeParitySnapshot(pool, "THREATFOX", {
      capturedAt: "2099-01-03T00:00:00.000Z",
    });

    expect(snapshot.records[0]?.facts.malwareFamily).toBeNull();
  });

  it("rejects explicit parity windows for sources without a source-native window contract", async () => {
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
    })).rejects.toThrow("currently supported only for NVD_CVE and THREATFOX");
  });
});

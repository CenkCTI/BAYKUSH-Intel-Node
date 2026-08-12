import type { Pool } from "pg";
import { NODE2G_PARITY_SCHEMA_VERSION, paritySnapshotSchema, type ParityRecord, type ParitySnapshot, type ProductionSourceKey } from "./parity.js";

interface RawRevisionRow {
  source_record_id: string;
  payload: unknown;
  published_at: Date | null;
  effective_at: Date | null;
  upstream_updated_at: Date | null;
}

interface ParityWindow {
  start: string;
  end: string;
}

const requiredBoundedSources = new Set<ProductionSourceKey>(["THREATFOX", "MALWAREBAZAAR"]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function displayText(value: unknown): string | null {
  const raw = text(value);
  return raw === null ? null : raw.replace(/\p{White_Space}+/gu, " ").trim();
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sourceInstant(value: unknown): string | null {
  const raw = text(value);
  if (raw === null) return null;
  const providerUtc = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: UTC)?$/i.exec(raw.trim());
  const normalized = providerUtc
    ? `${providerUtc[1]}-${providerUtc[2]}-${providerUtc[3]}T${providerUtc[4]}:${providerUtc[5]}:${providerUtc[6]}Z`
    : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? raw : parsed.toISOString();
}

function parityWindow(sourceKey: ProductionSourceKey, start?: string | null, end?: string | null): ParityWindow | null {
  if (!start && !end) {
    if (requiredBoundedSources.has(sourceKey)) {
      throw new Error(`${sourceKey} parity export requires an explicit provider first_seen window`);
    }
    return null;
  }
  if (!start || !end) throw new Error("Parity export requires both windowStart and windowEnd");
  if (sourceKey !== "NVD_CVE" && !requiredBoundedSources.has(sourceKey)) {
    throw new Error("Explicit parity windows are currently supported only for NVD_CVE, THREATFOX and MALWAREBAZAAR");
  }
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error("Parity export window must contain valid datetimes");
  if (startMs > endMs) throw new Error("Parity export windowStart must not be after windowEnd");
  return { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

function parityWindowColumn(sourceKey: ProductionSourceKey): "upstream_updated_at" | "effective_at" {
  if (sourceKey === "NVD_CVE") return "upstream_updated_at";
  if (sourceKey === "THREATFOX" || sourceKey === "MALWAREBAZAAR") return "effective_at";
  throw new Error(`No explicit parity-window column is defined for ${sourceKey}`);
}

function nodeFacts(sourceKey: ProductionSourceKey, payload: unknown): { subject: ParityRecord["subject"]; facts: Record<string, unknown> } {
  const root = object(payload);
  switch (sourceKey) {
    case "CISA_KEV": {
      const cve = text(root.cveID) ?? "UNKNOWN";
      return {
        subject: { kind: "CVE", value: cve },
        facts: {
          cve,
          dateAdded: text(root.dateAdded),
          dueDate: text(root.dueDate),
          // Legacy CİTEM trims/collapses presentation whitespace in these human-readable
          // fields. The parity projection compares their semantic text while raw Node
          // evidence remains byte-preserved in raw_source_records.
          vendor: displayText(root.vendorProject),
          product: displayText(root.product),
          ransomwareUse: text(root.knownRansomwareCampaignUse),
        },
      };
    }
    case "NVD_CVE": {
      const cve = text(root.id) ?? "UNKNOWN";
      return {
        subject: { kind: "CVE", value: cve },
        facts: {
          cve,
          published: sourceInstant(root.published),
          lastModified: sourceInstant(root.lastModified),
          vulnStatus: text(root.vulnStatus),
        },
      };
    }
    case "FIRST_EPSS": {
      const cve = text(root.cve) ?? "UNKNOWN";
      return {
        subject: { kind: "CVE", value: cve },
        facts: {
          cve,
          score: text(root.epss),
          percentile: text(root.percentile),
          scoreDate: text(root.scoreDate),
        },
      };
    }
    case "THREATFOX": {
      const source = object(root.source);
      const providerId = text(source.id) ?? "UNKNOWN";
      return {
        subject: { kind: "INDICATOR", value: text(source.ioc) ?? providerId },
        facts: {
          providerId,
          indicatorType: text(source.ioc_type),
          indicatorValue: text(source.ioc),
          firstSeen: sourceInstant(source.first_seen),
          lastSeen: sourceInstant(source.last_seen),
          // malware_malpedia is a reference URL, not a malware-family label.
          malwareFamily: text(source.malware_printable) ?? text(source.malware),
          providerConfidence: numberValue(source.confidence_level),
        },
      };
    }
    case "MALWAREBAZAAR": {
      const source = object(root.source);
      const sha256 = text(source.sha256_hash)?.toLowerCase() ?? "UNKNOWN";
      return {
        subject: { kind: "HASH", value: sha256 },
        facts: {
          sha256,
          sha1: text(source.sha1_hash)?.toLowerCase() ?? null,
          md5: text(source.md5_hash)?.toLowerCase() ?? null,
          firstSeen: sourceInstant(source.first_seen),
          lastSeen: sourceInstant(source.last_seen),
          fileName: text(source.file_name),
          fileSize: numberValue(source.file_size),
          fileType: text(source.file_type),
          fileTypeMime: text(source.file_type_mime),
          signature: text(source.signature),
          reporter: text(source.reporter),
          tags: Array.isArray(source.tags) ? source.tags : null,
        },
      };
    }
  }
}

const excludedRecordIds: Readonly<Record<ProductionSourceKey, readonly string[]>> = {
  CISA_KEV: ["__catalog_manifest__"],
  NVD_CVE: [],
  FIRST_EPSS: ["dataset-manifest"],
  THREATFOX: ["query-manifest"],
  MALWAREBAZAAR: ["query-manifest"],
};

export async function exportNodeParitySnapshot(
  pool: Pool,
  sourceKey: ProductionSourceKey,
  options: {
    upstreamSnapshotId?: string | null;
    capturedAt?: string;
    windowStart?: string | null;
    windowEnd?: string | null;
  } = {},
): Promise<ParitySnapshot> {
  const source = await pool.query<{
    id: string;
    source_class: string;
    observation_basis: string;
  }>(
    "SELECT id, source_class, observation_basis FROM source_definitions WHERE source_key = $1",
    [sourceKey],
  );
  const definition = source.rows[0];
  if (!definition) throw new Error(`${sourceKey} source definition is not synchronized`);

  const window = parityWindow(sourceKey, options.windowStart, options.windowEnd);
  const windowColumn = window ? parityWindowColumn(sourceKey) : null;
  const raw = await pool.query<RawRevisionRow>(
    `SELECT DISTINCT ON (source_record_id)
       source_record_id, payload, published_at, effective_at, upstream_updated_at
       FROM raw_source_records
      WHERE source_definition_id = $1
        AND NOT (source_record_id = ANY($2::text[]))
        ${windowColumn ? `AND ${windowColumn} >= $3::timestamptz AND ${windowColumn} <= $4::timestamptz` : ""}
      ORDER BY source_record_id, received_at DESC, created_at DESC`,
    window
      ? [definition.id, [...excludedRecordIds[sourceKey]], window.start, window.end]
      : [definition.id, [...excludedRecordIds[sourceKey]]],
  );

  const records: ParityRecord[] = raw.rows.map((row) => {
    const projected = nodeFacts(sourceKey, row.payload);
    return {
      sourceRecordId: row.source_record_id,
      subject: projected.subject,
      times: {
        publishedAt: row.published_at?.toISOString() ?? null,
        effectiveAt: row.effective_at?.toISOString() ?? null,
        upstreamUpdatedAt: row.upstream_updated_at?.toISOString() ?? null,
      },
      facts: projected.facts,
    };
  });

  return paritySnapshotSchema.parse({
    schemaVersion: NODE2G_PARITY_SCHEMA_VERSION,
    producer: "NODE",
    sourceKey,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    upstreamSnapshotId: options.upstreamSnapshotId ?? null,
    window: window ?? { start: null, end: null },
    semantics: {
      sourceClass: definition.source_class,
      observationBasis: definition.observation_basis,
    },
    records,
  });
}

import type { Pool } from "pg";
import { NODE2G_PARITY_SCHEMA_VERSION, paritySnapshotSchema, type ParityRecord, type ParitySnapshot, type ProductionSourceKey } from "./parity.js";

interface RawRevisionRow {
  source_record_id: string;
  payload: unknown;
  published_at: Date | null;
  effective_at: Date | null;
  upstream_updated_at: Date | null;
}

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
          malwareFamily: text(source.malware_printable) ?? text(source.malware) ?? text(source.malware_malpedia),
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
  options: { upstreamSnapshotId?: string | null; capturedAt?: string } = {},
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

  const raw = await pool.query<RawRevisionRow>(
    `SELECT DISTINCT ON (source_record_id)
       source_record_id, payload, published_at, effective_at, upstream_updated_at
       FROM raw_source_records
      WHERE source_definition_id = $1
        AND NOT (source_record_id = ANY($2::text[]))
      ORDER BY source_record_id, received_at DESC, created_at DESC`,
    [definition.id, [...excludedRecordIds[sourceKey]]],
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
    window: { start: null, end: null },
    semantics: {
      sourceClass: definition.source_class,
      observationBasis: definition.observation_basis,
    },
    records,
  });
}

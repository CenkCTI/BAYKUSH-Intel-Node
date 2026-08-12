import { z } from "zod";

export const NODE2G_PARITY_SCHEMA_VERSION = "NODE2G_PARITY_V1" as const;

export const productionSourceKeySchema = z.enum([
  "CISA_KEV",
  "NVD_CVE",
  "FIRST_EPSS",
  "THREATFOX",
  "MALWAREBAZAAR",
]);
export type ProductionSourceKey = z.infer<typeof productionSourceKeySchema>;

export const parityProducerSchema = z.enum(["NODE", "CITEM"]);
export type ParityProducer = z.infer<typeof parityProducerSchema>;

export const parityDifferenceClassificationSchema = z.enum([
  "SEMANTICALLY_EQUIVALENT",
  "NODE_SUPERSET",
  "INTENTIONAL_DIFFERENCE",
  "TEMPORAL_SKEW",
  "UNSUPPORTED_LEGACY",
  "REGRESSION",
  "UNCLASSIFIED",
]);
export type ParityDifferenceClassification = z.infer<typeof parityDifferenceClassificationSchema>;

const paritySemanticsSchema = z.object({
  sourceClass: z.string().min(1).max(128),
  observationBasis: z.string().min(1).max(128),
}).strict();

const parityTimesSchema = z.object({
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  effectiveAt: z.string().datetime({ offset: true }).nullable(),
  upstreamUpdatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export const parityRecordSchema = z.object({
  sourceRecordId: z.string().min(1).max(2_048),
  subject: z.object({
    kind: z.string().min(1).max(128),
    value: z.string().min(1).max(4_096),
  }).strict(),
  times: parityTimesSchema,
  facts: z.record(z.string().min(1).max(256), z.unknown()),
}).strict();
export type ParityRecord = z.infer<typeof parityRecordSchema>;

export const paritySnapshotSchema = z.object({
  schemaVersion: z.literal(NODE2G_PARITY_SCHEMA_VERSION),
  producer: parityProducerSchema,
  sourceKey: productionSourceKeySchema,
  capturedAt: z.string().datetime({ offset: true }),
  upstreamSnapshotId: z.string().min(1).max(2_048).nullable(),
  window: z.object({
    start: z.string().datetime({ offset: true }).nullable(),
    end: z.string().datetime({ offset: true }).nullable(),
  }).strict(),
  semantics: paritySemanticsSchema,
  records: z.array(parityRecordSchema).max(20_000),
}).strict();
export type ParitySnapshot = z.infer<typeof paritySnapshotSchema>;

export interface ManualParityClassification {
  side: "NODE_ONLY" | "CITEM_ONLY";
  sourceRecordId: string;
  classification: Exclude<ParityDifferenceClassification, "REGRESSION" | "UNCLASSIFIED">;
  reason: string;
}

export interface ParityDifference {
  kind: "FACT_MISMATCH" | "NODE_ONLY" | "CITEM_ONLY" | "SEMANTIC_MISMATCH" | "DUPLICATE_IDENTITY";
  sourceRecordId: string | null;
  field: string | null;
  nodeValue: unknown;
  citemValue: unknown;
  classification: ParityDifferenceClassification;
  reason: string;
}

export interface ParityComparison {
  schemaVersion: typeof NODE2G_PARITY_SCHEMA_VERSION;
  sourceKey: ProductionSourceKey;
  nodeRecords: number;
  citemRecords: number;
  intersection: number;
  nodeOnly: number;
  citemOnly: number;
  sameUpstreamSnapshot: boolean;
  blockingDifferences: number;
  unexplainedDifferences: number;
  accepted: boolean;
  differences: ParityDifference[];
}

interface SourceParityRule {
  criticalFactKeys: readonly string[];
  exactMembershipWhenSameSnapshot: boolean;
}

export const sourceParityRules: Readonly<Record<ProductionSourceKey, SourceParityRule>> = {
  CISA_KEV: {
    criticalFactKeys: ["cve", "dateAdded", "dueDate", "vendor", "product", "ransomwareUse"],
    exactMembershipWhenSameSnapshot: true,
  },
  NVD_CVE: {
    criticalFactKeys: ["cve", "published", "lastModified", "vulnStatus"],
    exactMembershipWhenSameSnapshot: true,
  },
  FIRST_EPSS: {
    criticalFactKeys: ["cve", "score", "percentile", "scoreDate"],
    exactMembershipWhenSameSnapshot: true,
  },
  THREATFOX: {
    criticalFactKeys: ["providerId", "indicatorType", "indicatorValue", "firstSeen", "lastSeen", "malwareFamily", "providerConfidence"],
    exactMembershipWhenSameSnapshot: false,
  },
  MALWAREBAZAAR: {
    criticalFactKeys: ["sha256", "sha1", "md5", "firstSeen", "lastSeen", "fileName", "fileSize", "fileType", "fileTypeMime", "signature", "reporter", "tags"],
    exactMembershipWhenSameSnapshot: false,
  },
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function uniqueRecordMap(snapshot: ParitySnapshot, differences: ParityDifference[]) {
  const records = new Map<string, ParityRecord>();
  for (const record of snapshot.records) {
    if (records.has(record.sourceRecordId)) {
      differences.push({
        kind: "DUPLICATE_IDENTITY",
        sourceRecordId: record.sourceRecordId,
        field: null,
        nodeValue: snapshot.producer === "NODE" ? record : null,
        citemValue: snapshot.producer === "CITEM" ? record : null,
        classification: "REGRESSION",
        reason: `${snapshot.producer} parity snapshot contains a duplicate source identity.`,
      });
      continue;
    }
    records.set(record.sourceRecordId, record);
  }
  return records;
}

function classificationForUnmatched(
  side: "NODE_ONLY" | "CITEM_ONLY",
  sourceRecordId: string,
  manual: readonly ManualParityClassification[],
  sameUpstreamSnapshot: boolean,
  rule: SourceParityRule,
): { classification: ParityDifferenceClassification; reason: string } {
  const explicit = manual.find((entry) => entry.side === side && entry.sourceRecordId === sourceRecordId);
  if (explicit) return { classification: explicit.classification, reason: explicit.reason };
  if (sameUpstreamSnapshot && rule.exactMembershipWhenSameSnapshot) {
    return {
      classification: "REGRESSION",
      reason: "A source that requires exact membership for the same upstream snapshot is missing this record on one side.",
    };
  }
  return {
    classification: "UNCLASSIFIED",
    reason: "The unmatched live record must be classified as temporal skew, intentional difference, Node superset, unsupported legacy behavior, or regression before cutover.",
  };
}

export function compareParitySnapshots(
  rawNode: unknown,
  rawCitem: unknown,
  manualClassifications: readonly ManualParityClassification[] = [],
): ParityComparison {
  const node = paritySnapshotSchema.parse(rawNode);
  const citem = paritySnapshotSchema.parse(rawCitem);
  if (node.producer !== "NODE" || citem.producer !== "CITEM") {
    throw new Error("Parity comparison requires NODE as the first snapshot and CITEM as the second snapshot");
  }
  if (node.sourceKey !== citem.sourceKey) throw new Error("Parity snapshots must represent the same sourceKey");

  const sourceKey = node.sourceKey;
  const rule = sourceParityRules[sourceKey];
  const differences: ParityDifference[] = [];
  const nodeRecords = uniqueRecordMap(node, differences);
  const citemRecords = uniqueRecordMap(citem, differences);
  const sameUpstreamSnapshot = node.upstreamSnapshotId !== null && node.upstreamSnapshotId === citem.upstreamSnapshotId;

  if (node.semantics.sourceClass !== citem.semantics.sourceClass) {
    differences.push({
      kind: "SEMANTIC_MISMATCH",
      sourceRecordId: null,
      field: "sourceClass",
      nodeValue: node.semantics.sourceClass,
      citemValue: citem.semantics.sourceClass,
      classification: "REGRESSION",
      reason: "Source class must remain semantically equivalent across the collection-authority cutover.",
    });
  }
  if (node.semantics.observationBasis !== citem.semantics.observationBasis) {
    differences.push({
      kind: "SEMANTIC_MISMATCH",
      sourceRecordId: null,
      field: "observationBasis",
      nodeValue: node.semantics.observationBasis,
      citemValue: citem.semantics.observationBasis,
      classification: "REGRESSION",
      reason: "Observation basis must remain semantically equivalent across the collection-authority cutover.",
    });
  }

  let intersection = 0;
  for (const [sourceRecordId, nodeRecord] of nodeRecords) {
    const citemRecord = citemRecords.get(sourceRecordId);
    if (!citemRecord) {
      const classified = classificationForUnmatched("NODE_ONLY", sourceRecordId, manualClassifications, sameUpstreamSnapshot, rule);
      differences.push({
        kind: "NODE_ONLY",
        sourceRecordId,
        field: null,
        nodeValue: nodeRecord.subject,
        citemValue: null,
        classification: classified.classification,
        reason: classified.reason,
      });
      continue;
    }
    intersection += 1;
    for (const field of rule.criticalFactKeys) {
      const nodeValue = nodeRecord.facts[field];
      const citemValue = citemRecord.facts[field];
      if (canonicalJson(nodeValue) === canonicalJson(citemValue)) continue;
      differences.push({
        kind: "FACT_MISMATCH",
        sourceRecordId,
        field,
        nodeValue,
        citemValue,
        classification: "REGRESSION",
        reason: `Critical ${sourceKey} source fact differs for the same source identity.`,
      });
    }
  }

  for (const [sourceRecordId, citemRecord] of citemRecords) {
    if (nodeRecords.has(sourceRecordId)) continue;
    const classified = classificationForUnmatched("CITEM_ONLY", sourceRecordId, manualClassifications, sameUpstreamSnapshot, rule);
    differences.push({
      kind: "CITEM_ONLY",
      sourceRecordId,
      field: null,
      nodeValue: null,
      citemValue: citemRecord.subject,
      classification: classified.classification,
      reason: classified.reason,
    });
  }

  const blockingDifferences = differences.filter((difference) => difference.classification === "REGRESSION").length;
  const unexplainedDifferences = differences.filter((difference) => difference.classification === "UNCLASSIFIED").length;
  return {
    schemaVersion: NODE2G_PARITY_SCHEMA_VERSION,
    sourceKey,
    nodeRecords: nodeRecords.size,
    citemRecords: citemRecords.size,
    intersection,
    nodeOnly: [...nodeRecords.keys()].filter((key) => !citemRecords.has(key)).length,
    citemOnly: [...citemRecords.keys()].filter((key) => !nodeRecords.has(key)).length,
    sameUpstreamSnapshot,
    blockingDifferences,
    unexplainedDifferences,
    accepted: blockingDifferences === 0 && unexplainedDifferences === 0,
    differences,
  };
}

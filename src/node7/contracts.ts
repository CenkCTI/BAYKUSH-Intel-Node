import { createHash } from "node:crypto";
import { canonicalJsonStringify } from "../runtime/raw-record.js";

export const NODE7_ELIGIBLE_ENTITY_TYPES = [
  "CVE",
  "IP",
  "DOMAIN",
  "URL",
  "HASH",
  "ASN",
  "CERTIFICATE",
] as const;

export const NODE7_CONTRIBUTING_OBSERVATION_BASES = [
  "OBSERVED",
  "REPORTED",
  "PUBLISHED",
] as const;

export const NODE7_CONTEXT_OBSERVATION_BASES = ["SCORED", "ENRICHED"] as const;

export const NODE7_SEMANTIC_BOUNDARY = Object.freeze({
  represents:
    "Deterministic source-system presence for an exact canonical technical subject, preserving upstream-origin and observation semantics.",
  doesNotRepresent:
    "Attack count, threat score, attribution, campaign identity, independent corroboration, causal relationship, attacker origin, victim identity, or strategic intent.",
});

export type PresenceState = "ACTIVE" | "RETRACTED";
export type PresenceTimePrecision = "NONE" | "INSTANT_ONLY" | "DATE_ONLY" | "MIXED";

export interface PresenceObservationCandidate {
  revisionId: string;
  state: PresenceState;
  role: string;
  observedTime: string | null;
  observedDate: string | null;
  nodeReceivedAt: string;
  acquisitionBasis: string;
}

export interface SourceSemanticSnapshot {
  sourceDefinitionId: string;
  sourceKey: string;
  sourceClass: string;
  observationBasis: "OBSERVED" | "REPORTED" | "PUBLISHED" | "SCORED" | "ENRICHED" | "UNKNOWN";
  upstreamOriginKey: string;
  semanticContractVersion: string;
}

export interface PresenceSummary {
  state: PresenceState;
  firstSeenTime: string | null;
  firstSeenDate: string | null;
  lastSeenTime: string | null;
  lastSeenDate: string | null;
  firstNodeReceivedAt: string | null;
  lastNodeReceivedAt: string | null;
  observationCount: number;
  primaryObservationCount: number;
  relatedObservationCount: number;
  acquisitionBases: string[];
  timePrecisionSummary: PresenceTimePrecision;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function entityIdentitySha256(entityType: string, entityKey: string): string {
  if (!entityType.trim() || !entityKey) throw new Error("Entity identity requires non-empty type and key");
  return sha256(`${entityType}\u0000${entityKey}`);
}

function temporalMillis(row: PresenceObservationCandidate): number {
  if (row.observedTime) {
    const value = Date.parse(row.observedTime);
    if (!Number.isFinite(value)) throw new Error(`Invalid observedTime ${row.observedTime}`);
    return value;
  }
  if (row.observedDate) {
    const value = Date.parse(`${row.observedDate}T00:00:00Z`);
    if (!Number.isFinite(value)) throw new Error(`Invalid observedDate ${row.observedDate}`);
    return value;
  }
  throw new Error("Presence observation must preserve either instant or date precision");
}

export function summarizePresenceObservations(
  rows: readonly PresenceObservationCandidate[],
): PresenceSummary {
  const active = rows.filter((row) => row.state === "ACTIVE");
  if (active.length === 0) {
    return {
      state: "RETRACTED",
      firstSeenTime: null,
      firstSeenDate: null,
      lastSeenTime: null,
      lastSeenDate: null,
      firstNodeReceivedAt: null,
      lastNodeReceivedAt: null,
      observationCount: 0,
      primaryObservationCount: 0,
      relatedObservationCount: 0,
      acquisitionBases: [],
      timePrecisionSummary: "NONE",
    };
  }

  const ordered = [...active].sort((left, right) => {
    const timeDelta = temporalMillis(left) - temporalMillis(right);
    return timeDelta || left.revisionId.localeCompare(right.revisionId);
  });
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const received = active
    .map((row) => row.nodeReceivedAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right) || left.localeCompare(right));
  const hasInstant = active.some((row) => row.observedTime !== null);
  const hasDate = active.some((row) => row.observedDate !== null);
  const primaryObservationCount = active.filter((row) => row.role === "PRIMARY").length;

  return {
    state: "ACTIVE",
    firstSeenTime: first.observedTime,
    firstSeenDate: first.observedDate,
    lastSeenTime: last.observedTime,
    lastSeenDate: last.observedDate,
    firstNodeReceivedAt: received[0]!,
    lastNodeReceivedAt: received[received.length - 1]!,
    observationCount: active.length,
    primaryObservationCount,
    relatedObservationCount: active.length - primaryObservationCount,
    acquisitionBases: [...new Set(active.map((row) => row.acquisitionBasis))].sort(),
    timePrecisionSummary: hasInstant && hasDate ? "MIXED" : hasInstant ? "INSTANT_ONLY" : "DATE_ONLY",
  };
}

export function presenceInputFingerprint(
  source: SourceSemanticSnapshot,
  rows: readonly PresenceObservationCandidate[],
): string {
  const normalizedRows = [...rows]
    .sort((left, right) => left.revisionId.localeCompare(right.revisionId))
    .map((row) => ({
      revisionId: row.revisionId,
      state: row.state,
      role: row.role,
      observedTime: row.observedTime,
      observedDate: row.observedDate,
      nodeReceivedAt: row.nodeReceivedAt,
      acquisitionBasis: row.acquisitionBasis,
    }));
  return sha256(canonicalJsonStringify({ source, observations: normalizedRows }));
}

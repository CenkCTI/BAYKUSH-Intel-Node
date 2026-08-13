import type { SourceAdapter } from "../contracts/source.js";
import type { PreparedRawRecord } from "../runtime/raw-record.js";

export function postgresDateOnly(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value ? value.slice(0, 10) : null;
}

export interface ClaimedBackfillSegment {
  id: string;
  requestId: string;
  sourceDefinitionId: string;
  sourceKey: string;
  segmentIndex: number;
  segmentKind: "INTERVAL" | "DATASET_DATE";
  windowStart: string | null;
  windowEnd: string | null;
  datasetDate: string | null;
  checkpoint: unknown;
  attemptCount: number;
}

export interface HistoricalPagePersistenceInput {
  segment: ClaimedBackfillSegment;
  workerId: string;
  adapter: SourceAdapter;
  descriptor: unknown;
  records: readonly PreparedRawRecord[];
  nextWork: unknown | null;
  complete: boolean;
}

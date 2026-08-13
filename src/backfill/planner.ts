export type HistoricalSegment =
  | { index: number; kind: "INTERVAL"; windowStart: string; windowEnd: string }
  | { index: number; kind: "DATASET_DATE"; datasetDate: string };

const DAY_MS = 86_400_000;

function parseInstant(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid historical backfill instant");
  return milliseconds;
}

export function planNvdHistoricalSegments(from: string, to: string): HistoricalSegment[] {
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (end <= start) throw new Error("Backfill end must be after start");
  const segments: HistoricalSegment[] = [];
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(cursor + DAY_MS, end);
    segments.push({
      index: segments.length,
      kind: "INTERVAL",
      windowStart: new Date(cursor).toISOString(),
      windowEnd: new Date(next).toISOString(),
    });
    cursor = next;
  }
  return segments;
}

export function planFirstEpssHistoricalSegments(from: string, to: string): HistoricalSegment[] {
  const start = parseInstant(from);
  const end = parseInstant(to);
  if (end <= start) throw new Error("Backfill end must be after start");
  const firstDay = Math.floor(start / DAY_MS) * DAY_MS;
  const segments: HistoricalSegment[] = [];
  for (let cursor = firstDay; cursor < end; cursor += DAY_MS) {
    segments.push({
      index: segments.length,
      kind: "DATASET_DATE",
      datasetDate: new Date(cursor).toISOString().slice(0, 10),
    });
  }
  return segments;
}

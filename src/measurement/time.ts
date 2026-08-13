import { z } from "zod";
import { measurementGranularitySchema, type MeasurementGranularity } from "./contracts.js";

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const offsetSuffix = /(Z|[+-][0-9]{2}:[0-9]{2})$/i;

export interface TimeBucket {
  start: string;
  end: string;
  granularity: MeasurementGranularity;
}

export function parseRfc3339Instant(value: string): Date {
  if (!offsetSuffix.test(value)) throw new Error("RFC3339 timestamp must include Z or an explicit offset");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid RFC3339 timestamp");
  return new Date(milliseconds);
}

export function parseDateOnly(value: string): string {
  const parsed = dateOnlySchema.parse(value);
  const [yearText, monthText, dayText] = parsed.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) {
    throw new Error("Invalid calendar date");
  }
  return parsed;
}

export function bucketForInstant(value: string | Date, granularityInput: MeasurementGranularity): TimeBucket {
  const granularity = measurementGranularitySchema.parse(granularityInput);
  const date = typeof value === "string" ? parseRfc3339Instant(value) : new Date(value.getTime());
  const milliseconds = date.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Invalid bucket timestamp");

  let startMs: number;
  let endMs: number;
  if (granularity === "FIVE_MINUTES") {
    const size = 5 * 60 * 1_000;
    startMs = Math.floor(milliseconds / size) * size;
    endMs = startMs + size;
  } else if (granularity === "HOUR") {
    const size = 60 * 60 * 1_000;
    startMs = Math.floor(milliseconds / size) * size;
    endMs = startMs + size;
  } else {
    startMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    endMs = startMs + 24 * 60 * 60 * 1_000;
  }

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    granularity,
  };
}

export function bucketForDate(value: string): TimeBucket {
  const date = parseDateOnly(value);
  const start = `${date}T00:00:00.000Z`;
  const startMs = Date.parse(start);
  return {
    start,
    end: new Date(startMs + 24 * 60 * 60 * 1_000).toISOString(),
    granularity: "DAY",
  };
}

export function enumerateBuckets(input: {
  from: string;
  to: string;
  granularity: MeasurementGranularity;
  maxBuckets?: number;
}): TimeBucket[] {
  const from = parseRfc3339Instant(input.from).getTime();
  const to = parseRfc3339Instant(input.to).getTime();
  if (to <= from) throw new Error("Time range end must be after start");
  const maxBuckets = input.maxBuckets ?? 10_000;
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1 || maxBuckets > 100_000) throw new Error("Invalid maxBuckets");

  const first = bucketForInstant(new Date(from), input.granularity);
  const output: TimeBucket[] = [];
  let cursor = Date.parse(first.start);
  while (cursor < to) {
    if (output.length >= maxBuckets) throw new Error("Time range exceeds bucket bound");
    const bucket = bucketForInstant(new Date(cursor), input.granularity);
    if (Date.parse(bucket.end) > from) output.push(bucket);
    cursor = Date.parse(bucket.end);
  }
  return output;
}

export function rangeContainsInstant(input: { from: string; to: string; value: string }): boolean {
  const from = parseRfc3339Instant(input.from).getTime();
  const to = parseRfc3339Instant(input.to).getTime();
  const value = parseRfc3339Instant(input.value).getTime();
  return value >= from && value < to;
}

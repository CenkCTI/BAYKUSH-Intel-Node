export const ROUTING_FINALIZATION_DELAY_MS = 180_000;

export interface RoutingMinuteDeltaRow {
  segmentId: string;
  captureProfileRevisionId: string | null;
  updateMessageCount: number;
  announcementPrefixEventCount: number;
  withdrawalPrefixEventCount: number;
  announcedPrefixes: readonly string[];
  withdrawnPrefixes: readonly string[];
  allPrefixes: readonly string[];
  originAsns: readonly number[];
  peerAsns: readonly number[];
  rrcs: readonly string[];
  rejectedMessageCount: number;
  inputFingerprint: string;
}

export interface StreamCoverageInterval {
  sessionId: string;
  captureProfileRevisionId: string | null;
  observedFrom: string;
  observedTo: string;
  degraded?: boolean;
}

export interface RoutingMinuteSnapshot {
  updateMessages: number;
  announcementPrefixEvents: number;
  withdrawalPrefixEvents: number;
  announcedPrefixes: string[];
  withdrawnPrefixes: string[];
  allPrefixes: string[];
  originAsns: number[];
  peerAsns: number[];
  rrcs: string[];
  rejectedMessages: number;
  inputSegmentCount: number;
  deltaProfileIds: string[];
}

export interface MinuteCoverageEvaluation {
  coverageStatus: "COMPLETE" | "PARTIAL" | "DEGRADED" | "NO_COVERAGE";
  dataAvailability: "AVAILABLE" | "PARTIAL" | "UNAVAILABLE";
  captureProfileRevisionId: string | null;
  intervalProfileIds: string[];
  continuous: boolean;
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueSortedNumbers(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

export function combineRoutingMinuteDeltas(rows: readonly RoutingMinuteDeltaRow[]): RoutingMinuteSnapshot {
  return {
    updateMessages: rows.reduce((sum, row) => sum + row.updateMessageCount, 0),
    announcementPrefixEvents: rows.reduce((sum, row) => sum + row.announcementPrefixEventCount, 0),
    withdrawalPrefixEvents: rows.reduce((sum, row) => sum + row.withdrawalPrefixEventCount, 0),
    announcedPrefixes: uniqueSortedStrings(rows.flatMap((row) => [...row.announcedPrefixes])),
    withdrawnPrefixes: uniqueSortedStrings(rows.flatMap((row) => [...row.withdrawnPrefixes])),
    allPrefixes: uniqueSortedStrings(rows.flatMap((row) => [...row.allPrefixes])),
    originAsns: uniqueSortedNumbers(rows.flatMap((row) => [...row.originAsns])),
    peerAsns: uniqueSortedNumbers(rows.flatMap((row) => [...row.peerAsns])),
    rrcs: uniqueSortedStrings(rows.flatMap((row) => [...row.rrcs])),
    rejectedMessages: rows.reduce((sum, row) => sum + row.rejectedMessageCount, 0),
    inputSegmentCount: rows.length,
    deltaProfileIds: uniqueSortedStrings(
      rows
        .map((row) => row.captureProfileRevisionId)
        .filter((value): value is string => Boolean(value)),
    ),
  };
}

export function normalizeCoverageIntervals(
  bucketStart: string,
  bucketEnd: string,
  intervals: readonly StreamCoverageInterval[],
): StreamCoverageInterval[] {
  const start = Date.parse(bucketStart);
  const end = Date.parse(bucketEnd);
  return intervals
    .map((interval) => {
      const observedFrom = Math.max(start, Date.parse(interval.observedFrom));
      const observedTo = Math.min(end, Date.parse(interval.observedTo));
      return {
        sessionId: interval.sessionId,
        captureProfileRevisionId: interval.captureProfileRevisionId,
        observedFrom: new Date(observedFrom).toISOString(),
        observedTo: new Date(observedTo).toISOString(),
        degraded: interval.degraded === true,
      };
    })
    .filter((interval) => {
      const intervalStart = Date.parse(interval.observedFrom);
      const intervalEnd = Date.parse(interval.observedTo);
      return Number.isFinite(intervalStart) && Number.isFinite(intervalEnd) && intervalEnd > intervalStart;
    })
    .sort((a, b) => {
      const startDelta = Date.parse(a.observedFrom) - Date.parse(b.observedFrom);
      if (startDelta !== 0) return startDelta;
      const endDelta = Date.parse(a.observedTo) - Date.parse(b.observedTo);
      return endDelta !== 0 ? endDelta : a.sessionId.localeCompare(b.sessionId);
    });
}

export function evaluateMinuteCoverage(input: {
  bucketStart: string;
  bucketEnd: string;
  intervals: readonly StreamCoverageInterval[];
  deltaProfileIds: readonly string[];
  rejectedMessages: number;
  hasObservedData: boolean;
}): MinuteCoverageEvaluation {
  const start = Date.parse(input.bucketStart);
  const end = Date.parse(input.bucketEnd);
  const overlapping = normalizeCoverageIntervals(input.bucketStart, input.bucketEnd, input.intervals);

  let cursor = start;
  for (const interval of overlapping) {
    const intervalStart = Date.parse(interval.observedFrom);
    const intervalEnd = Date.parse(interval.observedTo);
    if (intervalStart > cursor) break;
    cursor = Math.max(cursor, intervalEnd);
    if (cursor >= end) break;
  }
  const continuous = cursor >= end;

  const intervalProfileIds = uniqueSortedStrings(
    overlapping
      .map((interval) => interval.captureProfileRevisionId)
      .filter((value): value is string => Boolean(value)),
  );
  const allProfileIds = uniqueSortedStrings([...intervalProfileIds, ...input.deltaProfileIds]);
  const compatiblePopulation = allProfileIds.length === 1
    && overlapping.every((interval) => interval.captureProfileRevisionId === allProfileIds[0])
    && input.deltaProfileIds.every((profileId) => profileId === allProfileIds[0]);

  const degradedInterval = overlapping.some((interval) => interval.degraded === true);

  if (input.rejectedMessages > 0 || degradedInterval) {
    return {
      coverageStatus: "DEGRADED",
      dataAvailability: "PARTIAL",
      captureProfileRevisionId: compatiblePopulation ? allProfileIds[0] ?? null : null,
      intervalProfileIds,
      continuous,
    };
  }

  if (continuous && compatiblePopulation) {
    return {
      coverageStatus: "COMPLETE",
      dataAvailability: "AVAILABLE",
      captureProfileRevisionId: allProfileIds[0] ?? null,
      intervalProfileIds,
      continuous: true,
    };
  }

  if (overlapping.length > 0 || input.hasObservedData) {
    return {
      coverageStatus: "PARTIAL",
      dataAvailability: "PARTIAL",
      captureProfileRevisionId: compatiblePopulation ? allProfileIds[0] ?? null : null,
      intervalProfileIds,
      continuous,
    };
  }

  return {
    coverageStatus: "NO_COVERAGE",
    dataAvailability: "UNAVAILABLE",
    captureProfileRevisionId: null,
    intervalProfileIds,
    continuous: false,
  };
}

export function shouldFinalizeRoutingMinute(
  bucketEnd: string,
  now: Date,
  delayMs = ROUTING_FINALIZATION_DELAY_MS,
): boolean {
  return Date.parse(bucketEnd) + delayMs <= now.getTime();
}

export function shouldMaterializeRoutingGranularity(
  granularity: "ONE_MINUTE" | "FIVE_MINUTES" | "HOUR" | "DAY",
  bucketEnd: string,
  now: Date,
): boolean {
  if (granularity === "ONE_MINUTE") return true;
  return Date.parse(bucketEnd) <= now.getTime();
}

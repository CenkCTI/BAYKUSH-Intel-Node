# Coverage Model

## 1. Purpose

Coverage tells consumers whether a time interval was actually and sufficiently collected. It prevents collection failure from being mistaken for quiet cyber activity.

## 2. Coverage states

Controlled states:

- `COMPLETE` — expected collection opportunity was satisfied according to the source schedule and contract;
- `PARTIAL` — some valid collection occurred but the expected interval/work was not fully satisfied;
- `DEGRADED` — collection occurred under a known provider/runtime failure that makes the interval analytically unreliable;
- `NO_COVERAGE` — there is no valid collection evidence for the interval.

These are collection facts, not threat states.

## 3. Availability versus collection coverage

The Node separately tracks:

### Data availability

Do source-supported records exist for this historical interval?

### Live collection coverage

Did the Node actually perform the expected collection opportunity for this interval?

Historical bootstrap can yield:

```text
Data available: YES
Live collection coverage: NO
Acquisition: HISTORICAL_BACKFILL
```

This distinction is mandatory.

## 4. Valid zero

A measurement may be numeric zero only when its contract supports zero and the underlying collection opportunity is sufficiently known.

Example:

```text
scheduled opportunity: yes
coverage: COMPLETE
accepted matching records: 0
=> valid measurement value: 0
```

By contrast:

```text
collector offline
coverage: NO_COVERAGE
accepted matching records: unknown
=> measurement value: NULL / unavailable
```

## 5. Schedule history

Coverage evaluation must use historical schedule snapshots. Current cadence must not be projected backward onto old intervals.

Schedule history should preserve:

- enabled/disabled state;
- interval/cadence;
- effective start/end;
- intentional pause/archive;
- collection mode/version relevant to expected opportunities.

## 6. Coverage buckets

Coverage is aggregated into bounded time buckets suitable for measurements and diagnostics.

Initial granularities:

- five minutes where source cadence warrants it;
- hour;
- day.

Coverage aggregation must preserve whether any sub-bucket was unknown/degraded rather than averaging it away.

## 7. Manual and test collection

Manual/test collection can add data availability, but it does not prove a natural scheduled opportunity was fulfilled.

Consumers requiring strict natural collection history must be able to exclude or mark buckets contaminated by manual/test work.

## 8. Bootstrap/backfill

Historical backfill may repair data availability for old time periods.

It may not retroactively claim that the Node was continuously observing those periods.

Recovered intervals should expose:

- source-effective history;
- acquisition type;
- recovery completion;
- historical live-coverage unknown/not observed as applicable.

## 9. Unrecoverable gaps

If a live-only source was unavailable while the Node was offline, the interval remains a permanent explicit gap.

The UI/API should prefer a visible broken line/gap to a fabricated zero.

## 10. Source-health relationship

Source health can help explain coverage loss, but health and coverage remain separate derived facts.

For example:

```text
source health: AUTHENTICATION_ERROR
coverage: DEGRADED or NO_COVERAGE
measurement: unavailable
```

No layer may transform this into an activity decline.

## 11. API requirements

Measurement APIs must provide enough coverage metadata for clients to:

- render gaps;
- suppress invalid period-to-period comparisons;
- distinguish historical availability from live observation;
- explain partial/degraded intervals;
- show data freshness.

## 12. Acceptance invariant

A user must always be able to distinguish:

> We observed zero matching activity.

from:

> We do not know because collection coverage was absent or insufficient.
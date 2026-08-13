# NODE-3 — Historical Activity, Coverage & Measurement Backbone

## Scope

NODE-3 is one engineering phase above the accepted NODE-2 raw/canonical evidence pipeline. It creates historical, coverage-aware, revision-aware technical measurement infrastructure for the five admitted production TechINT sources.

NODE-3 does not perform analytic judgement and does not integrate CİTEM. CİTEM consumption is a later Node API consumer phase.

## Non-negotiable semantics

- Unknown is not zero.
- No coverage is not no activity.
- Reporting volume is not attack volume.
- IOC volume is not attack count.
- MalwareBazaar sample volume is not infection prevalence.
- EPSS is not observed exploitation, severity, risk, or priority.
- NVD records are not exploitation telemetry.
- CISA KEV membership is not exploit-event count.
- Bootstrap/backfill is not historical live observation.
- Revisions preserve prior truth; they do not rewrite it.
- Measurement is not analysis.

## Architecture

```text
PUBLIC SOURCES
      |
      v
COLLECTION RUNTIME
      |
      v
IMMUTABLE RAW EVIDENCE
      |
      v
NORMALIZER
      |
      v
IMMUTABLE CANONICAL EVIDENCE
      |
      +----------------------+----------------------+
      |                                             |
      v                                             v
MEASUREMENT PROJECTION                     COVERAGE RECONCILIATION
      |                                             |
      v                                             v
REVISIONED FACTS                            ACQUISITION WINDOWS
      |                                      + SCHEDULE HISTORY
      |                                             |
      +----------------------+----------------------+
                             |
                             v
                    REVISIONED AGGREGATION
                             |
                      5m / hour / day
                             |
                             v
                      VERSIONED READ API
```

A separate `measurement` runtime owns projection, entity history, coverage reconciliation and aggregate materialization. It receives no provider credentials.

## Time model

Controlled axes:

- `SOURCE_EFFECTIVE_TIME`
- `SOURCE_PUBLISHED_TIME`
- `UPSTREAM_UPDATED_TIME`
- `NODE_RECEIVED_TIME`
- `SOURCE_DATASET_DATE`

Date-only source facts remain date-only. Materialized buckets are UTC half-open intervals `[start,end)`.

Supported granularities are `FIVE_MINUTES`, `HOUR`, and `DAY`; each measurement contract exposes only meaningful granularities.

## Measurement contracts

`measurement_definitions` stores immutable semantic contracts. `measurement_calculation_versions` stores immutable calculation implementations. `measurement_definition_heads` points to the active semantic/calculation pair.

Reusing an existing contract/calculation version with a different canonical SHA-256 fails closed during registry synchronization.

Every measurement declares what it represents, what it does not represent, its time axis, coverage and zero policy, acquisition policy, comparison policy, dimensions and optional population profile.

## Live coverage versus data availability

These are independent truths.

Live collection coverage answers whether Node satisfied the scheduled observation opportunity at that historical time. Historical data availability answers whether source-supported evidence is now available for an interval.

A later historical recovery/backfill can make data available without changing historical live coverage from `NO_COVERAGE` to `COMPLETE`.

Only natural `SCHEDULED / LIVE_INCREMENTAL` collection can prove live coverage. Bootstrap, manual, repair, resync and backfill do not.

Public coverage states:

- `COMPLETE`
- `PARTIAL`
- `DEGRADED`
- `NO_COVERAGE`

Expectation is separate:

- `EXPECTED`
- `NOT_EXPECTED`
- `UNKNOWN`

Pre-NODE-3 schedule history is not fabricated. NODE-3 creates an explicit baseline and append-only authoritative schedule history from activation forward.

## Revision model

Measurement facts use a stable semantic `fact_key` plus immutable revision rows and a mutable current head. Corrected source values or corrected timestamps append a new revision. If event time moves, both old and new aggregate buckets become dirty.

Entity observations and entity history use the same append-only revision/head model. Superseded assertions can be retracted without deleting historical evidence. A late observation can move Node-dataset `first_seen` earlier and therefore revise novelty measurements.

## Aggregation

Dirty buckets are bounded and lease-safe. `dirty_revision` prevents an older worker from clearing newer work.

Five-minute, hourly and daily aggregates are calculated directly from active fact heads. Distinct counts are never created by summing smaller distinct buckets.

Aggregate history is immutable through `measurement_bucket_revisions`; `measurement_bucket_heads` points to the current revision. Distributions are bounded to contract-allowlisted dimensions and deterministic top-N + OTHER where required.

## As-of correctness

Default reads return latest knowledge. `asOf` reads choose aggregate revisions whose calculation time is on or before the requested knowledge boundary.

Provenance resolves the latest fact revision at the aggregate calculation boundary before applying the event-time bucket filter. This prevents a later corrected fact from leaking its prior event placement into a historical frozen view.

## Source semantics

### CISA KEV

Measures catalogue additions, BAYKUSH-observed record revisions, observed membership removals and confirmed catalogue size. Current snapshot reconstruction is not complete historical membership chronology.

### NVD CVE

Measures CVE publication and retained last-modified revision timelines separately. Last-modified query coverage does not automatically prove complete publication-time coverage.

### FIRST EPSS

Measures only the declared retained `EPSS_HIGH_SIGNAL_V1` population and its bounded score distribution. It never claims global EPSS population coverage. Model/population incompatibility suppresses comparisons.

### ThreatFox

Measures source report volume, exact distinct normalized indicators, Node-dataset novelty and BAYKUSH-observed report revisions. It does not measure attacks or independent corroboration.

### MalwareBazaar

Measures repository sample reporting, exact distinct SHA-256 identities, Node-dataset novelty and metadata revisions. It does not measure infections or prevalence.

## API boundary

NODE-3 exposes bounded `/v1/techint/*` read contracts. It does not expose arbitrary SQL or raw-table dumps. Future CİTEM integration consumes this API rather than connecting directly to Node PostgreSQL.

## Backfill boundary

Measurement rebuild uses existing immutable evidence and needs no provider access. Provider historical acquisition remains collector authority work.

`historical_backfill_requests` owns independent planning/checkpoint state. NODE-3 does not rewind or advance live `source_checkpoints` for historical measurement work.

## Completion rule

NODE-3 is mergeable only when all existing NODE-1/NODE-2 gates remain green, NODE-3 PostgreSQL acceptance passes, final/security audits pass, the compose boundary is valid, and live operator acceptance confirms the real five-source stack remains healthy and restart-safe.

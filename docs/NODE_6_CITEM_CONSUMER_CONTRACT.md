# NODE-6 — CİTEM Consumer Contract

## Purpose

This contract closes the downstream boundary between accepted NODE-6 routing telemetry and CİTEM Global View. It does not add a new source, change RIPE collection, change MRT recovery semantics, or perform intelligence assessment.

## Producer authority

BAYKUSH Intelligence Node remains authoritative for:

- RIPE RIS Live collection;
- MRT historical recovery;
- capture-profile population;
- one-minute routing truth;
- 5m/hour/day routing measurement materialization;
- coverage and data-availability state;
- acquisition provenance.

CİTEM is a read-only consumer and must not reconstruct missing routing data, aggregate raw one-minute history for long ranges, or rewrite coverage/provenance semantics.

## Measurement series

The canonical Global View routing measurements are:

- `routing.ripe_ris.update_messages`
- `routing.ripe_ris.announcement_prefix_events`
- `routing.ripe_ris.withdrawal_prefix_events`
- `routing.ripe_ris.distinct_prefixes_observed`
- `routing.ripe_ris.distinct_announced_prefixes`
- `routing.ripe_ris.distinct_withdrawn_prefixes`
- `routing.ripe_ris.distinct_origin_asns_observed`

CİTEM should consume these through the existing authenticated measurement API with `resolution=AUTO`. Distinct counts are not additive across buckets and must not be summed client-side to manufacture a range-wide distinct total.

## Operational status

`GET /v1/techint/routing/status`

Returns a bounded read-only operational view containing:

- source identity and RIPE attribution;
- stream-worker heartbeat freshness;
- latest stream-session state and observation timestamps;
- recovery-worker heartbeat freshness;
- latest recovery-request state;
- latest current routing bucket;
- current capture-profile identity/count where present.

Worker freshness is independent from routing coverage. A healthy/fresh worker does not imply historical COMPLETE coverage, and stale worker state does not erase already materialized historical data.

## Minute detail

`GET /v1/techint/routing/buckets?from=<RFC3339>&to=<RFC3339>&limit=<1..500>`

This endpoint remains a bounded minute-level integrity/detail API. Its range is limited to 24 hours and it is not a replacement for 5m/hour/day measurement materialization.

The detail response preserves:

- `coverageStatus`;
- `dataAvailability`;
- `acquisitionBasis`;
- `acquisitionChannel`;
- `liveCollectionCoverage`;
- capture-profile identity;
- recovery completeness metadata.

## Non-negotiable semantics

- BGP UPDATE count is not an incident count.
- Announcement observations are not attacks.
- Withdrawal observations are not outage verdicts.
- Origin changes are not hijack verdicts.
- RIPE RIS visibility is not complete global-Internet visibility.
- Missing coverage is not numeric zero.
- MRT-recovered availability does not rewrite historical live collection coverage.
- Infrastructure telemetry is a measurement input, not an intelligence judgement.

## Acquisition semantics

Current routing-minute heads may be backed by `LIVE_STREAM` or `MRT_RECOVERY`. Materialized 5m/hour/day routing measurements may expose mixed provenance when constituent minutes combine both bases.

CİTEM must preserve this distinction rather than flattening all available data into `LIVE`.

## Security boundary

- The Node API remains authenticated.
- CİTEM must call it server-side only.
- Browser clients must never receive the Node bearer token.
- The status endpoint exposes no filesystem paths, worker commands, staging keys, raw payloads, database connection details, or stack traces.
- The consumer contract is read-only.

## NODE-6 exit condition

NODE-6 consumer closure is complete only when CİTEM Global View contains an independent `Internet Infrastructure` lane that:

1. uses Node-materialized routing measurements for 24H/7D/30D history;
2. exposes coverage and provenance without inventing threat semantics;
3. distinguishes live collection history from recovered data availability;
4. remains isolated from Vulnerability and Malware/IOC semantics;
5. degrades safely if routing telemetry or the Node is unavailable.

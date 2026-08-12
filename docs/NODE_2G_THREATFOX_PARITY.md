# NODE-2G ThreatFox Shadow-Parity Contract

## Purpose

This document freezes the source-specific NODE-2G acceptance contract for ThreatFox before the live shadow capture is executed.

ThreatFox parity is **not** a raw-count equality test. The provider exposes a moving recent-IOC population and the Node and legacy CİTEM collectors use different recovery/high-water mechanics. Acceptance therefore proves that the same ThreatFox provider reports preserve the same critical source facts, while every unmatched provider ID is explicitly explained.

## Source semantics

- source key: `THREATFOX`
- source class: `IOC_SHARING`
- observation basis: `REPORTED`
- source-record identity: ThreatFox provider `id`

A ThreatFox IOC report is not an attack, victim, infection, compromise, or global attack-count observation. Reporting volume must never be reinterpreted as attack volume.

## Critical facts

For provider IDs present on both sides, parity is strict for:

- `providerId`
- `indicatorType`
- `indicatorValue`
- `firstSeen`
- `lastSeen`
- `malwareFamily`
- `providerConfidence`

The parity projection intentionally compares the provider-native IOC value, not an internal canonical signal/entity ID.

`malware_malpedia` is a reference URL and must not be reinterpreted as a malware-family label. The family label is `malware_printable`, falling back only to the provider `malware` identifier.

## Identity invariant

ThreatFox provider ID is the parity identity.

The IOC value is not used as source-record identity because the same IOC value may appear in more than one provider report. Internal Node IDs, CİTEM Technical Signal IDs, database UUIDs, and canonical entity IDs remain outside the parity contract.

## Two evidence layers

### Common-payload parity

A shared provider fixture is projected through the Node and CİTEM mappings before any live comparison. This removes provider-time skew and freezes critical-field behavior.

The shared fixture covers at minimum:

- provider ID preservation;
- raw `ip:port` IOC preservation for parity;
- provider `first_seen` and `last_seen` UTC normalization;
- malware-family label preservation;
- provider confidence preservation.

Additional legacy/Node capability differences such as hash IOC support remain subject to the NODE-2G difference taxonomy rather than being hidden by the common-payload test.

### Live shadow parity

Live parity uses a closed source-native window and compares intersecting provider IDs. Count equality is not required.

Every Node-only or CİTEM-only provider ID must be classified before acceptance. `REGRESSION` and `UNCLASSIFIED` remain blocking.

## Source-native time axis

ThreatFox `get_iocs` is defined around provider `first_seen`. The parity window therefore uses provider `first_seen`, never collector receipt time.

The two persistence layers expose the same upstream instant through different storage columns:

- Node raw source record: `effective_at = ThreatFox first_seen`
- legacy CİTEM observation: `source_published_at = ThreatFox first_seen`

NODE-2G exporters intentionally use those source-native columns for explicit ThreatFox windows.

This must not be replaced by `received_at`, `created_at`, Node checkpoint time, CİTEM observation creation time, or `last_seen`.

ThreatFox exports fail closed if the operator omits either window boundary. The Node comparator also rejects the comparison as `REGRESSION` unless both producers carry the same explicit normalized window. This prevents an unbounded retained-history export or two differently scoped populations from being mistaken for valid live parity.

## Stable interior window

The two live provider requests are not expected to complete at the same instant. To prevent records arriving between the requests from being misclassified as regressions, acceptance uses a stable interior window.

Recommended first acceptance window:

1. record the successful Node capture completion time;
2. record the successful CİTEM capture completion time;
3. take the earlier completion time;
4. subtract a 10-minute guard band to obtain `windowEnd`;
5. subtract 24 hours from `windowEnd` to obtain `windowStart`.

Example:

```text
Node completed   20:41:12Z
CİTEM completed  20:43:03Z

windowEnd        20:31:12Z
windowStart      previous day 20:31:12Z
```

The guard band is an acceptance control, not a provider semantic. If a materially different guard is used, the operator must record why.

## Snapshot identity

ThreatFox does not expose a CISA-style immutable catalog version or EPSS-style daily score-date snapshot for `get_iocs`.

Do not manufacture a fake same-snapshot identity such as `THREATFOX:2026-08-12`.

For live ThreatFox parity:

```text
upstreamSnapshotId = null
```

The shared closed `window` and provider IDs are the comparison scope.

## Export commands

Node:

```bash
npm run node2g:export-node -- THREATFOX - "$WINDOW_START" "$WINDOW_END" > /tmp/node-threatfox.json
```

CİTEM:

```bash
npm run node2g:shadow-export -- THREATFOX - "$WINDOW_START" "$WINDOW_END" > /tmp/citem-threatfox.json
```

Both snapshots must report the same normalized window boundaries. Calling either ThreatFox exporter without an explicit window is intentionally rejected.

## Pre-comparison diagnostics

Before the parity comparator is allowed to classify differences, record at minimum:

- total records;
- distinct provider IDs;
- duplicate provider IDs;
- minimum and maximum `firstSeen`;
- IOC-type distribution;
- null `lastSeen` count;
- malware-family null count;
- provider-confidence distribution or range;
- current Node recovery window and `recoveryGapExceeded` state;
- current CİTEM lookback/high-water state.

A duplicate provider ID inside one parity snapshot is a regression.

## Difference classification

Unmatched records are never bulk-labelled merely to make the comparator green.

Valid classifications require evidence:

- `TEMPORAL_SKEW` — provider revision/report timing is demonstrated by capture/source timestamps;
- `INTENTIONAL_DIFFERENCE` — documented recovery/lookback/high-water behavior explains the record;
- `UNSUPPORTED_LEGACY` — the provider record uses an IOC type the legacy CİTEM TechINT mapper does not support;
- `NODE_SUPERSET` — Node deliberately preserves valid source truth that the legacy path drops, with raw evidence showing why;
- `REGRESSION` — a supported provider report or critical fact is lost/changed without an accepted architectural reason;
- `UNCLASSIFIED` — evidence is insufficient.

`REGRESSION > 0` or `UNCLASSIFIED > 0` blocks ThreatFox acceptance.

## Unsupported legacy behavior

Legacy CİTEM's current ThreatFox TechINT bridge maps `domain`, `url`, and `ip:port` IOC types. Node additionally preserves recognized hash IOC types and can preserve unknown/unmappable provider reports as raw source truth.

A Node-only hash or source report is not automatically accepted. The raw provider record must demonstrate that the absence is caused by the frozen legacy mapping boundary before `UNSUPPORTED_LEGACY` or `NODE_SUPERSET` is assigned.

## Recovery semantics

Node uses bounded adaptive ThreatFox recovery up to the provider's seven-day recent-IOC limit and persists `recoveryGapExceeded` when the recovery horizon is insufficient.

A later successful collection must not erase the epistemic fact that historical coverage was incomplete.

`HEALTHY` therefore means the current request path is healthy; it does not mean complete historical coverage.

## Acceptance result shape

A valid accepted result may have unequal counts:

```text
sourceKey               = THREATFOX
nodeRecords             = <n>
citemRecords            = <m>
intersection            = <i>
nodeOnly                = <classified>
citemOnly               = <classified>
sameUpstreamSnapshot    = false
blockingDifferences     = 0
unexplainedDifferences  = 0
accepted                = true
```

Count inequality alone is not evidence of a regression.

## ThreatFox exit gates

ThreatFox is accepted only when all of the following are true:

- Node latest live collection succeeded;
- CİTEM latest live collection succeeded;
- Node normalization failures are zero for the acceptance capture;
- provider credentials are absent from parity artifacts and persisted evidence;
- common-payload critical-fact tests are green on both repositories;
- explicit windows on both exporters use provider `first_seen` semantics;
- both exporters reject unbounded ThreatFox parity exports;
- the comparator rejects missing or mismatched ThreatFox windows;
- a stable guarded 24-hour live window has been captured;
- duplicate provider IDs are zero;
- every intersecting provider ID has zero unexplained critical-fact mismatch;
- every Node-only record is evidence-backed and classified;
- every CİTEM-only record is evidence-backed and classified;
- `REGRESSION = 0`;
- `UNCLASSIFIED = 0`;
- recovery-gap state is recorded;
- the NODE-2 acceptance report contains the exact operator evidence.

Only then may `docs/NODE_2_ACCEPTANCE_REPORT.md` mark ThreatFox live shadow parity as `PASS`.

# Source Admission — FIRST EPSS Daily Scores

## Identity

- Source key: `FIRST_EPSS`
- Publisher/service: FIRST EPSS Special Interest Group / Empirical Security score publication ecosystem
- Upstream origin: `FIRST_EPSS`
- Source class: `EXPLOIT_PROBABILITY`
- Observation basis: `SCORED`
- Authority type: `INDUSTRY_SCORING_SYSTEM`
- Collection mode: `SNAPSHOT`
- Default poll interval: 21600 seconds
- Minimum poll interval: 3600 seconds
- Authentication requirement: `NONE`
- Credential kind: none
- Enabled by default: no

## What the source represents

FIRST EPSS publishes a probability score for public CVEs. The score estimates the likelihood of exploitation activity being observed in the next 30 days within the EPSS data-partner/sensor ecosystem. EPSS also publishes a percentile indicating the proportion of scored vulnerabilities at or below a score.

BAYKUSH stores that source-published probability evidence with the source score date and model version.

## What it does not establish

An EPSS score does not by itself establish:

- an exploitation event;
- an attack;
- an attack count;
- a victim;
- active exploitation;
- vulnerability severity;
- CVSS;
- whether the vulnerability exists in a specific environment;
- whether an asset is reachable/exposed;
- compensating controls;
- business impact;
- business risk;
- remediation priority;
- attacker identity or geography;
- a BAYKUSH threat level or Global Priority.

EPSS is one possible input into later analysis. NODE-2D does not perform that later analysis.

## Official bulk-delivery behavior

The production adapter uses FIRST's current daily compressed CSV:

```text
https://epss.empiricalsecurity.com/epss_scores-current.csv.gz
```

FIRST documents the EPSS API as a lookup/small-batch mechanism and directs bulk/local synchronization to the daily CSV or historical repository. NODE-2D therefore does not use `api.first.org` for bulk synchronization.

The stable current URL redirects to a dated daily artifact. Redirect following is explicit and bounded rather than delegated to unrestricted automatic HTTP behavior.

## Core dataset fields

Required source columns:

```text
cve
epss
percentile
```

Current files also include a leading metadata comment containing a source model version and score date. NODE-2D requires this metadata for current production collection and preserves it as source truth.

Schema policy is strict for required identity/scoring fields and tolerant of bounded additive columns.

## Probability interpretation

EPSS values are validated in the closed interval `[0,1]`.

NODE-2D preserves the source decimal string in raw evidence and converts it to a numeric canonical fact for deterministic queries.

A score is not transformed into qualitative labels such as:

```text
LOW
MEDIUM
HIGH
CRITICAL
```

The source did not make that classification.

## Threshold policy

NODE-2D uses the bounded capture profile:

```text
EPSS_HIGH_SIGNAL_V1
minimumEpss = 0.10
maximumRecords = 2500
```

FIRST does not define 0.10 as a universal authoritative threshold. In BAYKUSH it is a capture/storage policy only.

A CVE absent from the retained Node population is therefore not score zero and is not safe by implication.

## Full validation, bounded persistence

The complete daily CSV is downloaded, decompressed, and parsed before the source run is accepted.

The Node validates every source row but persists only the profile-selected score population and one dataset manifest.

This distinction prevents two misleading statements:

1. the retained Node population is not the complete global EPSS distribution;
2. the Node has still validated the complete artifact used to derive the retained population.

## Selection order

Retained rows are selected deterministically by:

```text
EPSS descending
percentile descending
CVE lexical ascending
```

Provider row ordering is not part of the capture contract.

## Malformed-row policy

A malformed score row fails the complete snapshot rather than being skipped.

This is stricter than the earlier CİTEM API adapter. Silent row skipping could change the top-K result and therefore manufacture a false retained population.

Duplicate CVEs in one daily dataset also fail the snapshot because NODE-2D has no source-supported basis for choosing one of multiple same-date values.

## Dataset metadata and model versions

The source model version is preserved exactly as supplied.

NODE-2D does not hard-code the current EPSS model. Future source model versions remain acceptable without changing the BAYKUSH normalization version, provided the source schema/semantics remain compatible.

Historical movement across model-version boundaries must be interpreted carefully. NODE-3 can use the preserved model version to avoid treating a methodology change as ordinary same-model score movement.

## Artifact integrity

The source artifact is protected by:

- compressed byte bound;
- decompressed byte bound;
- gzip magic validation;
- gzip decompression/CRC behavior;
- row/column/record bounds;
- compressed artifact SHA-256;
- decompressed dataset SHA-256;
- selected-population SHA-256.

The complete original `.csv.gz` is not stored in PostgreSQL in NODE-2D.

## Dataset manifest

One immutable raw `dataset-manifest` revision records the provenance of each changed daily artifact.

The manifest is deliberately not normalized into an intelligence record. It documents collection provenance, not a cyber fact about a CVE.

## Raw score identity

Stable source record identity:

```text
source_record_id = CVE ID
```

Raw idempotency remains:

```text
(source_definition_id, source_record_id, payload_sha256)
```

Because source date and dataset hash are part of the score raw payload, daily time-series revisions and same-day source corrections remain distinguishable.

## Canonical mapping

Every retained score becomes:

```text
record_kind   = EXPLOIT_PROBABILITY_SCORE
canonical_key = epss:<CVE-ID>
```

The only canonical entity in v1 is the CVE.

Canonical facts retain:

- numeric score;
- numeric percentile;
- score date;
- date precision;
- model version;
- dataset content hash;
- BAYKUSH capture-profile identity and bounds.

No risk, severity, attack-count, or active-exploitation fact is generated.

## Relationship to NVD and CISA KEV

The same CVE may converge across multiple upstream origins:

```text
NVD       -> VULNERABILITY_RECORD
CISA KEV  -> KNOWN_EXPLOITED_VULNERABILITY
FIRST     -> EXPLOIT_PROBABILITY_SCORE
```

These records must remain semantically distinct even though they share a CVE entity.

EPSS probability is not independent evidence that a KEV event occurred. CISA KEV membership supersedes probability when the question is whether the source says exploitation is already known.

## Time semantics

Retained score records use the source score date as published/effective date at date precision.

`received_at` remains the Node collection time.

HTTP Last-Modified is not used as a row-level vulnerability timestamp; it remains artifact transport metadata.

## Snapshot/idempotency behavior

If the provider returns an unchanged daily artifact:

```text
same dataset date
same dataset content SHA-256
```

NODE-2D returns zero new source records.

If the provider returns HTTP 304 with a valid completed checkpoint, the run succeeds with zero records.

If the provider republishes the same date with different content, a new manifest/relevant raw revisions are preserved.

## Regression/anomaly policy

The adapter rejects a current dataset date older than the completed checkpoint.

Under the same source model version, an extreme sudden population drop (below 75% of the previous successful row count) is treated as a retryable snapshot-integrity anomaly rather than silently accepted.

The guard does not infer threat activity and is relaxed across source model-version changes.

## Historical/recovery policy

FIRST publishes a historical daily archive, so the source contract declares historical retrieval support and `HISTORICAL_QUERY` recovery.

NODE-2D v1 does not automatically backfill missed days. It admits the current production source only.

Historical backfill and explicit coverage repair belong to NODE-3.

## Credential policy

No credential is required.

The generic artifact transport still strips known sensitive headers when a redirect crosses hosts so later source reuse cannot accidentally forward credentials.

## Redirect policy

Allowed production paths are limited to:

```text
/epss_scores-current.csv.gz
/epss_scores-YYYY-MM-DD.csv.gz
```

on the explicitly allowlisted HTTPS provider host.

The adapter rejects:

- non-HTTPS redirects;
- unallowlisted hosts;
- unallowlisted paths;
- redirect loops/excess depth;
- URL-embedded credentials.

## Licensing and attribution posture

FIRST states that EPSS scores are published freely and requests attribution when EPSS data is used in products or publications.

NODE-2D records a conservative source-lineage posture:

```text
commercialUseStatus = UNKNOWN
redistributionStatus = UNKNOWN
```

This intentionally avoids turning a source-use statement into a legal/commercial-license conclusion. Commercial launch should receive a dedicated license/terms review.

## Operator policy

The source is registered disabled by default and must be enabled explicitly:

```bash
npm run sources -- status FIRST_EPSS
npm run sources -- enable FIRST_EPSS
npm run sources -- disable FIRST_EPSS
```

CI does not contact the live provider.

## Known limitations

NODE-2D does not retain every EPSS score every day. It cannot later reconstruct an unselected score from local raw evidence alone.

The retained population therefore must always carry its capture-profile semantics.

Full-score historical storage, historical backfill, distributions, score movers, model-adjusted deltas, KEV/EPSS convergence measurements, and Global View presentation remain later phases.

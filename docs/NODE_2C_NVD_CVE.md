# NODE-2C — NVD CVE Production Adapter

## Goal

Admit the NIST National Vulnerability Database CVE API 2.0 as BAYKUSH Intelligence Node's second production intelligence source.

NODE-2C is not a generic "download CVEs" integration. It creates a restart-safe, rate-conscious, immutable vulnerability-record revision pipeline while preserving the semantic difference between NVD enrichment, CISA KEV membership, future FIRST EPSS probability, and eventual BAYKUSH risk/priority projections.

## Runtime flow

```text
NVD CVE API 2.0
  -> fixed last-modified window
  -> offset pagination
  -> provider-paced bounded HTTPS
  -> strict-core / tolerant-edge validation
  -> immutable NVD raw CVE revisions
  -> normalization jobs
  -> VULNERABILITY_RECORD
  -> cve:<CVE-ID>
  -> raw provenance
```

## Source semantics

NVD is represented as a `VULNERABILITY_DATABASE` with observation basis `ENRICHED`.

NVD publishes CVE records and enrichment state including descriptions, status, scoring metadata, weaknesses, references, and CPE applicability information. This does not make NVD a direct exploitation sensor.

NODE-2C must never infer from NVD data alone:

- attack count;
- victim count;
- active exploitation;
- exploit probability;
- business risk;
- remediation priority;
- threat level.

NVD fields that mirror CISA KEV data remain preserved in immutable raw JSON but do not generate an independent `KNOWN_EXPLOITED_VULNERABILITY` canonical assertion. CISA and NVD can converge on the same global `cve:<ID>` key without being counted as two independent observations of exploitation.

## Collection contract

- source key: `NVD_CVE`;
- collection mode: `PAGED_POLL`;
- default and minimum automated poll interval: 7200 seconds;
- API: CVE API 2.0;
- default/max page size: 2000 records;
- provider date-range maximum: 120 consecutive days;
- BAYKUSH bootstrap window: 24 hours;
- BAYKUSH recovery segment: 24 hours;
- live overlap: 5 minutes;
- inter-page pacing: 6.5 seconds;
- response bound: 64 MiB;
- NVD raw CVE bound: 4 MiB;
- historical retrieval: supported;
- recovery strategy: `HISTORICAL_QUERY`;
- enabled by default: no.

NVD recommends no more than one automated maintenance cycle every two hours and recommends sleeping six seconds between requests. BAYKUSH uses 6.5 seconds as a conservative page-to-page pacing floor.

## Optional API key

NVD does not require an API key, but a key raises the published request allowance. NODE-2C therefore introduces a tri-state source-auth contract:

```text
NONE
OPTIONAL
REQUIRED
```

`NVD_CVE` uses `OPTIONAL` and credential kind `NVD_API_KEY`.

The key is read only from process configuration and is sent only through the `apiKey` HTTP request header. It is never intentionally persisted in:

- source definitions;
- checkpoints;
- work descriptors;
- raw records;
- canonical evidence;
- source URLs.

The shared HTTP layer also supports exact-value redaction if a provider echoes a configured secret in a diagnostic response header.

## Bootstrap and live windows

A source with no checkpoint starts with one frozen 24-hour last-modified window:

```text
targetEnd   = run planning time
windowEnd   = targetEnd
windowStart = targetEnd - 24h
```

This first run remains `BOOTSTRAP / INITIAL_BOOTSTRAP`, so later measurement logic can distinguish ingestion from live technical activity.

After a successful window, scheduled maintenance queries use:

```text
windowStart = completedThrough - 5m
windowEnd   = min(completedThrough + 24h, targetEnd)
```

The five-minute overlap intentionally prefers duplicate retrieval over silent gaps. Existing Node raw idempotency removes an identical `(source, CVE ID, payload SHA-256)` redelivery.

If the Node has been offline for many days, a single run advances through chained 24-hour segments until the frozen `targetEnd` is reached. BAYKUSH therefore stays far below NVD's 120-day hard range while keeping retries small and recovery progress explicit.

## Restart-safe pagination

The checkpoint is source-specific:

```text
{
  version: 1,
  completedThrough: datetime | null,
  activeWindow: {
    windowStart,
    windowEnd,
    targetEnd,
    startIndex,
    expectedTotalResults,
    restartCount
  } | null
}
```

Each work unit is exactly one NVD page. The work descriptor also carries the pre-window completion boundary and an optional `notBeforeRequestAt` pacing timestamp.

After each successful page, the page's raw inserts, normalization jobs, next checkpoint, next work unit, and current work completion remain in the same PostgreSQL transaction through the existing NODE-2A runtime.

`completedThrough` does not advance until the final page of a logical window is safely persisted.

## Mutable offset pagination defense

NVD uses offset pagination. The response's `startIndex` must match the requested `startIndex` and the page population must be internally consistent with `resultsPerPage` and `totalResults`.

The first page freezes `expectedTotalResults`. If a later page reports a different total population, NODE-2C discards that page and restarts the same fixed time window at index zero. Already persisted identical CVEs are harmless because raw persistence is idempotent.

Window restarts are bounded. Repeated population changes eventually produce a retryable `SOURCE_SNAPSHOT_CHANGED` failure rather than silently advancing a potentially incomplete checkpoint.

## Valid zero

NVD documents that a valid HTTP 200 response may contain zero results. NODE-2C treats:

```text
totalResults = 0
vulnerabilities = []
```

as a successful observed zero for the queried source window. It is not an error and it is not `NO_COVERAGE`.

## Raw truth and revisions

One NVD raw record is the exact source `cve` object from the response, not the pagination wrapper.

```text
source_record_id = CVE ID
```

Pagination metadata, request windows, and offsets are deliberately excluded from the CVE raw payload fingerprint. Therefore moving the same CVE between pages or re-reading it through an overlap cannot manufacture a revision.

An unchanged CVE remains idempotent. A changed source CVE becomes a new immutable raw revision.

Source timestamps map conservatively:

```text
published_at        = cve.published
effective_at        = NULL
upstream_updated_at = cve.lastModified
received_at         = Node receipt time
```

## Validation policy

NODE-2C follows `strict core + tolerant edges`.

Required core fields are validated:

- CVE ID;
- source identifier;
- published timestamp;
- last-modified timestamp;
- vulnerability status.

The richer NVD payload is allowed to evolve. Additive fields remain in raw JSON even when the current normalizer does not project them.

Known and future status strings are preserved source-native. `Rejected` records are not filtered out.

## Canonical output

Every accepted NVD CVE revision normalizes to:

```text
record_kind   = VULNERABILITY_RECORD
canonical_key = cve:<CVE-ID>
```

The v1 canonical entity list contains only the global CVE entity. NODE-2C does not prematurely invent cross-source vendor/product identities from CPE or prose.

Canonical facts can include:

- NVD CVE ID;
- source identifier;
- source-native vulnerability status;
- descriptions;
- all source-provided CVSS metric collections with their source/type/version distinctions intact;
- weakness structures;
- CVE tags;
- vendor comments;
- reference count;
- explicit configuration/CPE count metadata.

There is intentionally no single BAYKUSH "authoritative CVSS" field.

## CPE applicability

NVD configurations can represent logical applicability with AND/OR, nested nodes, version ranges, negation, and CPE matches. Flattening the tree into a simple vendor/product list would change its meaning.

NODE-2C therefore preserves the complete configuration tree in raw truth and emits only explicit metadata counts in canonical v1. A future logic-aware applicability projection may model the tree without rewriting NODE-2C history.

## NVD attribution and transformation boundary

NVD asks API-using services to display a notice that use of the NVD API does not imply NVD endorsement or certification. NODE-2C records the NVD Terms of Use in source metadata.

Raw records represent NVD source content. Canonical records are BAYKUSH-normalized projections derived from NVD and must not be represented as NVD-authored modified content.

## Explicitly out of scope

NODE-2C does not add:

- full historical NVD population;
- CVE Change History API ingestion;
- CPE Dictionary mirroring;
- an affected-product graph;
- a single authoritative CVSS selection;
- EPSS joins;
- KEV/NVD priority scores;
- risk scoring;
- AI summaries;
- threat levels;
- attribution or geography;
- CİTEM Global View reads or measurements.

## Acceptance

Automated acceptance covers source admission, optional credential handling, fixed bootstrap windows, pagination, mid-window checkpoints, overlap, immutable revisions, Rejected retention, zero-result success, multiple CVSS preservation, CPE non-flattening, additive source fields, CISA-mirror non-corroboration, API-key redaction, pagination drift restart, migration compatibility, and raw-to-canonical PostgreSQL flow.

CI remains network-independent. A manual live NVD smoke test is required before merge.

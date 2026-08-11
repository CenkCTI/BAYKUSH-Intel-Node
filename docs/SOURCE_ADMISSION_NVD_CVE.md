# Source Admission — NVD CVE API 2.0

## Identity

- Source key: `NVD_CVE`
- Publisher/service: National Vulnerability Database, NIST
- Upstream origin: `NVD_CVE`
- Source class: `VULNERABILITY_DATABASE`
- Observation basis: `ENRICHED`
- Authority type: `GOVERNMENT_DATABASE`
- Collection mode: `PAGED_POLL`
- Default poll interval: 7200 seconds
- Minimum poll interval: 7200 seconds
- Authentication requirement: `OPTIONAL`
- Credential kind: `NVD_API_KEY`
- Enabled by default: no

## What the source represents

NVD exposes CVE records and enrichment state through its CVE API. The NVD enrichment workflow can associate reference tags, CVSS, CWE, and CPE applicability information and can retain source-contributed vulnerability information.

BAYKUSH records the state that NVD publishes. The Node does not claim it directly observed the underlying vulnerability exploitation or attack activity.

## What it does not establish

An NVD CVE record does not by itself establish:

- an exploit event;
- an attack;
- a victim;
- active exploitation;
- exploit likelihood;
- business impact;
- business risk;
- remediation priority;
- attacker identity or geography.

NVD fields reflecting CISA KEV data do not count as a second independent upstream confirmation of exploitation.

## Official API behavior used by NODE-2C

The production adapter uses only the NVD CVE API 2.0 collection endpoint.

NVD documents:

- zero-based `startIndex` offset pagination;
- a default and maximum `resultsPerPage` of 2000;
- `lastModStartDate` plus `lastModEndDate` for maintaining a local repository;
- a maximum 120-consecutive-day date range;
- default inclusion of Rejected CVE records unless `noRejected` is requested;
- API keys in the `apiKey` request header for API 2.0;
- public and keyed request limits;
- an approximately six-second inter-request sleep recommendation;
- a recommendation not to automate maintenance queries more frequently than once every two hours.

NODE-2C intentionally does not send `noRejected`.

## Credential policy

`NVD_API_KEY` is optional. It is never placed in a URL or persisted in Node source state.

The source contract distinguishes optional credentials from required credentials rather than pretending every external API is either fully public or unusable without authentication.

The legacy `requires_auth` database column is retained during the additive compatibility period. A new `auth_requirement` column stores `NONE`, `OPTIONAL`, or `REQUIRED`.

## Historical/recovery policy

The NVD provider supports historical last-modified queries. NODE-2C therefore declares `HISTORICAL_QUERY` recovery with a provider maximum of 120 days.

Operationally, BAYKUSH uses 24-hour recovery segments with a five-minute overlap. Historical data availability must not later be confused with historical live collection coverage.

A full all-time NVD backfill remains a history-phase concern rather than NODE-2C admission scope.

## Record identity

The stable source record identity is the CVE ID.

Raw idempotency remains:

```text
(source_definition_id, source_record_id, payload_sha256)
```

The raw payload is only the source `cve` object. API pagination wrapper fields are not copied into every CVE and therefore cannot manufacture false revisions.

## Pagination integrity

Every response must agree with the requested start index and remain internally consistent with pagination metadata.

The first page records the fixed window's expected total result population. A later population change causes a bounded replay from index zero using the same window. BAYKUSH prefers replay plus deterministic idempotency over advancing a potentially incomplete offset cursor.

Repeated instability becomes a retryable source-snapshot failure and does not advance the source completion boundary.

## Schema policy

The adapter validates a conservative required core while preserving additive provider fields through passthrough raw JSON.

This prevents an unannounced optional NVD schema addition from disabling useful collection while still failing closed on missing CVE identity or invalid core timestamps.

## Rejected CVEs

Rejected CVE records remain source truth. NODE-2C does not filter them and does not delete earlier revisions when a CVE becomes Rejected.

The latest projection may later identify the current source status as Rejected, while immutable history still preserves the states previously received by BAYKUSH.

## CVSS policy

NVD can expose metric collections contributed by different sources and with different types or CVSS versions. NODE-2C preserves these distinctions.

The adapter does not collapse multiple source assessments into one score and does not derive risk, priority, or exploitation likelihood from CVSS.

## CPE policy

NVD applicability structures can carry nested boolean logic and version criteria. NODE-2C stores the complete source tree in raw truth and does not flatten it into global vendor/product assertions.

Only explicit count/presence metadata is emitted in canonical v1.

## CISA mirror policy

NVD CVE objects may expose CISA-related fields. These are intentionally retained in raw truth but excluded from NVD canonical facts in NODE-2C.

The authoritative BAYKUSH KEV assertion remains the `CISA_KEV` source admitted in NODE-2B. This preserves upstream-origin accounting for future convergence logic.

## Attribution and terms

The source definition references NVD's API Terms of Use. Applications using NVD data should not imply endorsement or certification by NVD. BAYKUSH canonical records are marked and treated as BAYKUSH-normalized derivatives, not modified NVD-authored records.

## Operator policy

The source is registered disabled and requires explicit operator enablement:

```bash
npm run sources -- status NVD_CVE
npm run sources -- enable NVD_CVE
npm run sources -- disable NVD_CVE
```

An optional API key may be supplied through the runtime environment:

```text
NVD_API_KEY=...
```

Do not commit credentials to the repository.

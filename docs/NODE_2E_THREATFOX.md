# NODE-2E — ThreatFox Recent IOC Reporting Adapter

## Goal

NODE-2E admits the abuse.ch ThreatFox Community API as a production-grade recent IOC reporting source for BAYKUSH Intelligence Node.

The adapter preserves a strict semantic boundary:

> A ThreatFox IOC report is evidence that ThreatFox reported an indicator with source-defined metadata. It is not, by itself, evidence of an attack, victim, attacker origin, current maliciousness, business risk, or independent corroboration.

## Upstream contract

NODE-2E uses the authenticated ThreatFox Community API recent-IOC query:

- endpoint: `POST https://threatfox-api.abuse.ch/api/v1/`
- authentication: `Auth-Key` HTTP header only
- body: `{ "query": "get_iocs", "days": N }`
- supported recent window: 1–7 days, based on upstream `first_seen`

NODE-2E intentionally does not use the bulk export URL because that flow embeds the Auth-Key in the URL. Header-only authentication reduces the chance of credentials entering URLs, provenance fields, diagnostics, or logs.

## Source definition

| Field | Value |
| --- | --- |
| source key | `THREATFOX` |
| source class | `IOC_SHARING` |
| observation basis | `REPORTED` |
| authority type | `COMMUNITY_IOC_SHARING_PLATFORM` |
| collection mode | `SNAPSHOT` |
| default poll | 3600 seconds |
| minimum poll | 3600 seconds |
| historical retrieval | false |
| recovery | `SNAPSHOT_RECONSTRUCTION` |
| auth | `REQUIRED` |
| credential kind | `THREATFOX_AUTH_KEY` |
| enabled by default | false |

The one-hour cadence is a BAYKUSH operational choice intended to keep the Community API collection conservative and bounded. It is not a ThreatFox claim about the ideal polling interval.

## Recovery model

ThreatFox `get_iocs` accepts only a relative 1–7 day window. There is no cursor that BAYKUSH can safely invent.

NODE-2E therefore uses an adaptive overlapping recovery window:

- no checkpoint: 7 days;
- gap <= 24 h: 1 day;
- larger gaps: `ceil(gap / 24 h)`;
- maximum: 7 days;
- gap > 7 days: query 7 days and set `recoveryGapExceeded=true`.

A gap beyond seven days is not silently treated as complete coverage. NODE-3 will later formalize coverage state using the preserved checkpoint and query-manifest evidence.

## Checkpoint

Checkpoint schema v1 records:

- last successful collection time;
- last source snapshot fingerprint;
- last raw response SHA-256;
- previous IOC count;
- maximum source `first_seen` value;
- recovery window days;
- recovery-gap-exceeded state.

No provider cursor, IOC ID, array index, or `first_seen` value is misrepresented as a pagination cursor.

## Query manifest

Every materially changed query context or response produces one raw-only `THREATFOX_QUERY_MANIFEST` containing:

- query selector;
- days requested;
- source query status;
- IOC count;
- exact HTTP response byte count and SHA-256 digest;
- order-independent source snapshot fingerprint;
- minimum and maximum source `first_seen` times;
- recovery-gap-exceeded state.

The manifest normalizes to zero canonical intelligence records.

Exact same source bytes, source snapshot, record count, and query/recovery context return zero collection records. If only provider array order changes, the response SHA changes but the semantic snapshot fingerprint stays stable; the manifest preserves that provenance while unchanged IOC records deduplicate at raw persistence.

## Raw IOC evidence

Each IOC is persisted as:

```json
{
  "kind": "THREATFOX_IOC",
  "source": { "...": "ThreatFox source object" }
}
```

The source object uses strict required core fields with tolerant additive fields. Unknown upstream fields are preserved in raw evidence but do not receive invented canonical meaning.

Raw source identity is the ThreatFox IOC `id`. Existing runtime uniqueness on `(source, source_record_id, payload_sha256)` provides immutable revisions and exact-payload deduplication.

Query-window metadata is deliberately not injected into IOC raw payloads; otherwise a one-day versus seven-day query would create fake IOC revisions.

## Canonical output

Each valid raw IOC report normalizes to:

```text
record_kind   = IOC_REPORT
canonical_key = threatfox:ioc:<ThreatFox-ID>
```

The canonical record identity belongs to the source report, not to the indicator itself. This allows the same indicator to be independently reported by future sources without collapsing upstream evidence.

### Supported indicator mapping

NODE-2E normalizes known source types conservatively:

- `domain` -> `DOMAIN`
- `url` -> `URL`
- `ip:port` -> `IP` plus `threatfox.port`
- `md5_hash` -> `HASH` key prefixed `md5:`
- `sha1_hash` -> `HASH` key prefixed `sha1:`
- `sha256_hash` -> `HASH` key prefixed `sha256:`

URL hostnames normalize while path/query case is preserved. IP service ports remain facts rather than being embedded in IP entity identity.

Unknown IOC types produce an `IOC_REPORT` with `baykush.indicator_normalization_status=UNMAPPED`. Malformed values of known types produce `INVALID_SOURCE_VALUE`. Useful source reporting is therefore not hidden merely because indicator normalization is incomplete.

## Malware mapping

When ThreatFox supplies a malware label, NODE-2E may add a `MALWARE` entity keyed as `malpedia:<source-malware-label>` and retain source-provided display/alias/Malpedia metadata.

This is a ThreatFox source assertion. It is not independent BAYKUSH attribution.

## Canonical facts

The normalizer preserves source-scoped facts such as:

- ThreatFox IOC ID;
- raw IOC value and source IOC type;
- source threat type and descriptions;
- ThreatFox confidence level;
- first seen and last seen;
- reporter;
- source reference;
- tags;
- source malware labels and Malpedia reference;
- source `is_compromised` when present;
- extracted port for `ip:port`;
- indicator normalization status.

ThreatFox confidence stays `threatfox.confidence_level`; it is never mapped to BAYKUSH analytic confidence.

## Time semantics

For IOC reports:

- `received_at`: BAYKUSH ingestion time, set by the runtime;
- `effective_at`: ThreatFox `first_seen`;
- `published_at`: null;
- `upstream_updated_at`: null;
- ThreatFox `last_seen`: source fact only.

`first_seen` is not treated as a publication timestamp, and `last_seen` is not treated as a record-update timestamp.

## HTTP and secret security

NODE-2E extends the shared source HTTP layer with bounded POST support while keeping GET as the default.

Controls include:

- HTTPS-only fixed host/path;
- no credentials in URL;
- explicit `GET`/`POST` methods only;
- GET request bodies rejected;
- bounded request body;
- bounded response body;
- manual redirects only; 3xx fails closed for this endpoint;
- timeout and transport classification;
- 401/403 authentication classification;
- 429 `Retry-After` support;
- 5xx retryable provider failure;
- JSON content-type and parsing checks;
- exact Auth-Key redaction from provider diagnostic headers.

`THREATFOX_AUTH_KEY` is optional at process startup so a disabled source cannot prevent Node startup. Enabling ThreatFox without a configured key fails with controlled `AUTHENTICATION_ERROR`.

The key must never be persisted in raw payloads, canonical facts, checkpoints, work descriptors, source URLs, manifests, or logs.

## Bounds

NODE-2E v1 uses:

- maximum response: 32 MiB;
- maximum request body: 16 KiB;
- maximum IOCs per query: 9,999;
- one additional query manifest, keeping one work unit at or below the Node hard cap of 10,000 records;
- maximum individual raw record: 256 KiB.

If the provider exceeds a hard bound, the run fails. NODE-2E never silently truncates a source response because silent truncation would falsely imply coverage.

## Licensing and source admission

ThreatFox Community API usage is governed by abuse.ch fair-use and Terms of Use. NODE-2E records:

- `licenseClass=ABUSE_CH_FAIR_USE_2025_11_04`
- `commercialUseStatus=RESTRICTED`
- `redistributionStatus=UNKNOWN`

A commercial BAYKUSH deployment must re-evaluate the upstream license/subscription contract before enabling this source in that context.

## Testing

Network-independent tests cover:

- exact POST endpoint and Auth-Key header;
- no key in URL/body/persistence;
- request/response bounds;
- auth redaction and rate-limit behavior;
- source semantic contract;
- adaptive recovery windows;
- strict core/tolerant edge source validation;
- six known indicator families;
- URL case preservation;
- unknown/invalid indicator fallback;
- query-manifest zero normalization;
- source-attributed confidence;
- negative analytic predicates;
- source time semantics;
- order-independent snapshot fingerprint;
- exact idempotency;
- recovery-context manifest preservation;
- duplicate source-ID anomaly handling;
- PostgreSQL raw -> normalization -> canonical flow;
- immutable source revisions;
- zero normalization failures.

CI never calls the live ThreatFox service.

## Manual live acceptance before merge

A real ThreatFox Auth-Key must be configured locally without sharing or printing it. Manual acceptance will verify, one command at a time:

1. disabled source state;
2. key configured without revealing its value;
3. isolated ThreatFox bootstrap;
4. healthy source/run state;
5. raw IOC + query-manifest counts;
6. zero normalization failures;
7. sample raw/canonical provenance;
8. semantic boundary and time mapping;
9. supported live IOC normalization;
10. repeat-run dedup/revision behavior;
11. source disabled after test;
12. restoration of prior local source state.

## Out of scope

NODE-2E does not implement:

- ThreatFox IOC submission;
- `search_ioc`, `search_hash`, `taginfo`, `malwareinfo`, `types`, or `malware_list` production polling;
- full six-month export ingestion;
- historical backfill beyond the Community API recent window;
- source convergence or independent corroboration;
- GeoIP or attacker-origin inference;
- IOC risk, severity, priority, or current-maliciousness scoring;
- measurements, distributions, movers, or Global View charts;
- CİTEM private investigation data;
- AI interpretation.

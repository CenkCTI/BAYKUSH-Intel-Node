# Source Admission — CISA Known Exploited Vulnerabilities

## Source identity

- Source key: `CISA_KEV`
- Publisher: Cybersecurity and Infrastructure Security Agency (CISA)
- Upstream origin: `CISA_KEV`
- Source class: `EXPLOITED_VULNERABILITY_CATALOG`
- Observation basis: `PUBLISHED`
- Authority type: `GOVERNMENT`
- Collection mode: `SNAPSHOT`
- Default poll interval: 3600 seconds
- Minimum poll interval: 900 seconds
- Authentication: none
- Enabled by default: no

## What the source represents

CISA publishes the Known Exploited Vulnerabilities catalog as an authoritative list of vulnerabilities CISA has determined have been exploited in the wild. BAYKUSH records CISA's publication state and its revisions.

The Node observation basis remains `PUBLISHED`: the Node observes CISA's catalog, not exploit events directly.

## What the source does not establish

A KEV entry does not establish:

- one attack;
- one victim;
- global attack volume;
- the date exploitation first occurred;
- that exploitation occurred at `dateAdded`;
- that `dueDate` is a universal remediation deadline outside its source policy context;
- that ransomware value `Unknown` means `No`;
- that exploitation stopped if an entry later disappears from the catalog;
- that BAYKUSH directly observed exploitation.

## Official distribution and lineage

CISA is the single upstream origin. NODE-2B knows two CISA-controlled retrieval channels:

1. preferred machine retrieval: the official `cisagov/kev-data` GitHub repository raw JSON on its `develop` branch;
2. fallback: the canonical CISA JSON feed under `cisa.gov`.

These are not independent corroborating sources. A future convergence layer must count them as one upstream origin.

The official GitHub repository states that its KEV files are sourced from the CISA KEV catalog, are updated shortly after the canonical source, and exist to make automated consumption and history tracking easier.

## Licensing

The official `cisagov/kev-data` repository distributes KEV under CC0 1.0. CISA states that the data may be used in any legal manner, while third-party links included in KEV remain subject to their own policies. The license does not authorize use of the CISA logo or DHS seal and use must not imply CISA/DHS endorsement.

Node source metadata therefore records:

- license class: `CC0-1.0`;
- commercial use: `ALLOWED`;
- redistribution: `ALLOWED`;
- no endorsement implication.

## Record identity

One vulnerability entry uses its CVE identifier as the stable source record identity:

```text
CVE-YYYY-NNNN...
```

The catalog snapshot itself is represented by a separate raw manifest record:

```text
__catalog_manifest__
```

Entry raw payloads deliberately exclude catalog-level metadata. This prevents a catalog version/date change from manufacturing revisions for every unchanged CVE.

## Snapshot manifest

Each changed snapshot produces a manifest containing:

- `catalogVersion`;
- `dateReleased`;
- `count`;
- exact downloaded-body SHA-256;
- sorted-membership SHA-256;
- sorted CVE membership list.

Manifest history permits later reconstruction of additions and removals without inventing a deletion/exploitation event.

## Snapshot validation

A snapshot is accepted only if all of the following hold:

- HTTPS transport and fixed endpoint validation pass;
- body is no larger than 8 MiB;
- JSON parses successfully;
- top-level catalog fields validate;
- catalog contains 1–5000 entries;
- declared count equals the vulnerability array length;
- every required entry validates;
- CVE identifiers match CISA's published pattern;
- source dates are valid calendar dates;
- no duplicate CVE identifier exists.

The catalog is authoritative and full-snapshot based, so NODE-2B fails closed rather than skipping malformed mandatory entries. A partial parse could create a false absence.

Unknown additive entry fields are preserved in immutable raw payloads even when the current normalizer does not use them.

## Change and idempotency semantics

The exact HTTP body is SHA-256 fingerprinted. Conditional requests use ETag and Last-Modified when the validator belongs to the same retrieval channel.

- `304` -> successful run with zero accepted records;
- `200` with the same body SHA-256 -> successful run with zero accepted records;
- changed body -> validate the complete snapshot atomically;
- unchanged entry payload -> raw idempotency conflict, no new revision;
- changed entry payload -> new immutable raw revision;
- new entry -> new immutable raw record;
- changed manifest -> new immutable manifest revision.

A removed CVE does not produce a fabricated raw deletion record. Its absence is recoverable by comparing immutable manifest membership lists.

## Timestamp semantics

`dateAdded` and `dueDate` are date-only source fields and remain date-only canonical facts. NODE-2B does not convert them to `00:00:00Z` and thereby invent precision.

For vulnerability-entry raw rows:

- `published_at = NULL`;
- `effective_at = NULL`;
- `upstream_updated_at = NULL`.

The catalog manifest has an actual source datetime (`dateReleased`), so it may use that datetime as its publication/effective time.

## Canonical output

Each KEV entry normalizes to:

```text
record_kind = KNOWN_EXPLOITED_VULNERABILITY
canonical_key = cve:<CVE-ID>
```

Entities:

- global deterministic `CVE` identity;
- CISA-scoped deterministic `VENDOR` identity;
- CISA-scoped deterministic `PRODUCT` identity.

Vendor/product strings are not promoted to cross-source global identity in NODE-2B. Later convergence may reconcile them.

Canonical facts preserve source-native values including:

- catalog membership;
- CVE ID;
- vendor/project;
- product;
- vulnerability name;
- date added;
- due date;
- short description;
- required action;
- ransomware campaign-use value when present;
- notes when present;
- CWE list when present.

## Recovery

Recovery strategy is `SNAPSHOT_RECONSTRUCTION`.

After downtime, the Node can recover the current catalog and source-provided `dateAdded` values, but a current snapshot alone does not prove every intermediate revision that occurred while the Node was offline. Historical Git commit backfill from the official CISA repository is intentionally deferred to the history phase.

Historical data availability must not be reported as historical live collection coverage.

## Operator policy

CISA KEV is synchronized into the Node registry but remains disabled until an operator explicitly enables it:

```bash
npm run sources -- enable CISA_KEV
npm run sources -- status CISA_KEV
npm run sources -- disable CISA_KEV
```

Source health is operational telemetry only and must never be folded into cyber-activity or threat-level measurements.

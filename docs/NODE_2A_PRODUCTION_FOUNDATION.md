# NODE-2A — Production Source Foundation

## Goal

Prepare the NODE-1 runtime for real external sources without admitting a production source yet.

NODE-2A creates the common behavior that CISA KEV, NVD, FIRST EPSS, ThreatFox, and MalwareBazaar must share. Source-specific collection begins in NODE-2B.

## Runtime changes

### Bootstrap versus live collection

The scheduler now labels a source's first run as:

- trigger: `BOOTSTRAP`;
- purpose: `INITIAL_BOOTSTRAP`.

Only after that source has a successful collection run do later scheduled runs become `LIVE_INCREMENTAL`.

This distinction is mandatory so later measurement logic cannot interpret initial ingestion of historical/catalog data as current technical activity.

### Retry and backoff

Collection runs and work units have durable `available_at` timestamps. Retryable failures cannot be reclaimed before that timestamp.

Retry delay uses bounded exponential backoff and may be extended by a provider `Retry-After` hint. Provider rate limits therefore do not become immediate retry loops.

### Bounded source HTTP transport

`src/http/source-http.ts` provides a shared GET transport with:

- HTTPS-only fixed endpoints;
- exact hostname/path admission;
- no URL credentials;
- manual redirect rejection;
- bounded response bytes;
- bounded request timeout;
- controlled HTTP/auth/rate-limit/provider errors;
- `Retry-After` parsing;
- JSON content validation without logging provider response bodies or credentials.

Source adapters may set stricter source-specific bounds in later NODE-2 phases.

## Raw versus canonical processing

Collection and normalization are intentionally separated.

```text
source
  -> collector
  -> immutable raw_source_records
  -> normalization_jobs
  -> normalizer
  -> immutable canonical_evidence_records
```

A successful raw insert enqueues a normalization job in the same PostgreSQL transaction as the raw record and checkpoint/work-unit persistence.

An identical upstream redelivery does not insert another raw record and therefore does not create a duplicate normalization job.

Normalization failures do not delete or rewrite raw source truth.

## Canonical evidence persistence

`canonical_evidence_records` stores:

- raw-record provenance;
- source definition and upstream origin;
- source-record identity;
- controlled canonical record kind/key;
- receipt, published, effective, and upstream-update times;
- bounded entities, facts, references;
- source semantic boundary;
- adapter, normalization, and semantic-contract versions;
- deterministic normalized SHA-256.

Canonical rows are immutable. A changed normalization algorithm must use a new normalization version rather than rewriting previous canonical output.

## Source registry synchronization

The TypeScript adapter registry is synchronized into PostgreSQL before scheduling and through the operator CLI.

Metadata may be updated from the adapter contract, while the operator-controlled `enabled` state is preserved.

Existing raw records that lack a job for the current normalization version are safely backfilled into the normalization queue during registry synchronization.

## Operator source control

Production sources are not implicitly enabled merely because an adapter exists.

Commands:

```bash
npm run sources -- list
npm run sources -- enable SOURCE_KEY
npm run sources -- disable SOURCE_KEY
```

Later production adapters will enter the registry disabled by default and require an explicit operator enablement after source admission and credentials are ready.

## Runtime processes

NODE-2A Docker Compose processes are:

- PostgreSQL;
- migration runner;
- API;
- scheduler;
- collection worker;
- canonical normalizer.

`/v1/health` can report `NORMALIZER` heartbeat alongside API, scheduler, and worker heartbeats.

## Acceptance

Automated validation covers:

- migration/checksum idempotency;
- immutable raw and canonical records;
- bounded HTTP transport;
- fixed endpoint rejection;
- rate-limit `Retry-After` handling;
- retry backoff;
- NODE-1 collection invariants;
- first-run `INITIAL_BOOTSTRAP` classification;
- raw record -> normalization job creation;
- canonical normalization and provenance;
- transition from bootstrap to `LIVE_INCREMENTAL` after the first successful run;
- TypeScript build and container build.

## Explicitly out of scope

NODE-2A does not add live collection from:

- CISA KEV;
- NVD;
- FIRST EPSS;
- ThreatFox;
- MalwareBazaar.

It also does not implement historical measurements, coverage aggregation, CİTEM Global View APIs, Oracle deployment hardening, or ANLAK projection.

Those remain in NODE-2B+ and later roadmap phases.

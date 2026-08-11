# Source Adapter Contract

## 1. Goal

Every source integrated into BAYKUSH Intelligence Node must satisfy the same explicit contract. A source is not admitted merely because an API or feed exists.

The contract prevents source-specific assumptions from leaking into the global data model and makes collection, recovery, licensing, semantics, and measurements auditable.

## 2. Source definition

Each source definition must declare:

- `source_key`: immutable machine identifier;
- `display_name`;
- `provider_name`;
- `upstream_origin_key`;
- `source_class`;
- `observation_basis`;
- `authority_type`;
- `collection_mode`;
- `default_poll_interval_seconds` when applicable;
- `minimum_poll_interval_seconds` when specified by the provider;
- `supports_historical_retrieval`;
- `recovery_strategy`;
- `historical_max_window` when bounded;
- `requires_auth`;
- `credential_kind` when applicable;
- `adapter_version`;
- `semantic_contract_version`;
- `license_class`;
- `commercial_use_status`;
- `redistribution_status`;
- `attribution_requirement`;
- `terms_reference`;
- `enabled_by_default`.

## 3. Controlled collection modes

### `POLL`

Small bounded endpoint or feed fetched periodically.

### `PAGED_POLL`

Endpoint requiring deterministic bounded pagination or continuation tokens.

### `SNAPSHOT`

A source publishes a current dataset or periodic full snapshot. Snapshot acquisition must not be interpreted as all records becoming new at ingestion time.

### `STREAM`

Long-running/event stream. Deferred to NODE-6 for production sources.

## 4. Recovery strategies

### `HISTORICAL_QUERY`

The provider supports bounded date/time retrieval.

### `CURSOR_CATCHUP`

The provider exposes a reliable cursor/continuation strategy sufficient to retrieve records missed during downtime.

### `SNAPSHOT_RECONSTRUCTION`

Current or historical snapshots can reconstruct source-effective history, but reconstruction does not prove historical live collection coverage.

### `LIVE_ONLY`

Missed periods cannot be recovered from the source. Downtime must remain an explicit coverage gap.

## 5. Adapter interface responsibilities

A source adapter must conceptually provide:

1. `definition()` — immutable source metadata and semantic contract;
2. `plan()` — convert due collection/recovery state into bounded work;
3. `fetch()` — execute one bounded upstream request/work unit;
4. `identifyRawRecord()` — derive deterministic upstream record identity;
5. `extractTimes()` — extract supported upstream time fields without inventing timestamps;
6. `normalize()` — map a raw record into one or more canonical evidence outputs;
7. `checkpoint()` — produce the next durable cursor only after successful persistence;
8. `classifyFailure()` — distinguish provider, auth, rate-limit, schema, transport, and internal failures;
9. `measurementCapabilities()` — declare which measurements can legitimately be derived from the source.

Exact TypeScript signatures are deferred to NODE-1.

## 6. Adapter rules

Adapters must:

- validate upstream payloads;
- preserve raw source payload or a policy-approved faithful representation;
- use deterministic identifiers where possible;
- never advance a durable cursor before all accepted records are durably persisted;
- treat duplicate delivery as normal and idempotent;
- preserve source timestamps separately from Node receipt time;
- never convert missing fields to fabricated zero/empty facts;
- fail closed on unsupported schema changes;
- expose partial results only when the source contract and collection runtime can mark coverage `PARTIAL`;
- respect provider rate limits and documented fair-use requirements;
- avoid unbounded page traversal in a single work unit.

## 7. Source admission checklist

No production source is enabled until the following are documented and tested:

- Who publishes the source?
- What exactly is being observed, reported, published, scored, or enriched?
- What does the source not establish?
- What constitutes one record?
- What is the stable record identity?
- Which timestamps are authoritative and what do they mean?
- Does the source expose updates/revisions?
- Is historical retrieval possible?
- What recovery behavior is supported after Node downtime?
- What are the provider rate limits?
- Does it require a credential?
- What are the license, attribution, commercial-use, and redistribution terms?
- Is the source original or a mirror/derivative of another upstream origin?
- What constitutes a real empty result versus a provider/coverage failure?
- What schema-change behavior is safe?
- Which canonical record kinds may the adapter produce?
- Which measurement definitions are valid for the source?
- Which misleading interpretations must UI/API metadata explicitly reject?

## 8. Source health

Each source exposes derived operational health separate from activity:

- last attempt;
- last success;
- current run state;
- consecutive failures;
- freshness against expected cadence;
- rate-limit state where known;
- authentication state;
- latest schema incompatibility;
- latest recoverable/unrecoverable gap.

Source health must never be folded into a cyber-activity score.

## 9. First source set

NODE-2 targets:

- CISA KEV;
- NVD CVE;
- FIRST EPSS;
- ThreatFox;
- MalwareBazaar.

Later sources are admitted only through this contract.
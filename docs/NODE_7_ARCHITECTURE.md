# NODE-7 — Convergence, Lineage, Geography & Discovery

## Status

This document freezes the NODE-7 semantic architecture. NODE-7A/B implements only the stable technical-entity registry and revisioned source-presence foundation described below. Later NODE-7 PRs must build on these contracts rather than introduce a second entity truth store.

## Purpose

NODE-7 makes deterministic relationships between already-collected technical facts visible without converting correlation into attribution or strategic judgement.

The core analyst question is:

> Which exact canonical technical subjects are being observed or reported by multiple source systems, which truly distinct upstream origins support those observations, when did those observations occur, and what evidence/geo basis is available?

NODE-7 does not answer who attacked whom, whether two observations share a cause, whether an entity is malicious, or whether a routing change is an attack/outage/hijack.

## Existing truth reused by NODE-7

NODE-7 is a projection over existing Node truth:

```text
raw_source_records
  -> canonical_evidence_records
  -> entity_observation_revisions / entity_observation_heads
  -> entity_history_revisions / entity_history_heads

source_definitions
  -> source_key
  -> source_class
  -> observation_basis
  -> upstream_origin_key
  -> semantic_contract_version
```

The canonical `(entity_type, entity_key)` pair remains authoritative. The NODE-7 UUID registry is a stable database surrogate for that exact identity; it does not perform fuzzy matching or alias resolution.

## Non-negotiable semantic invariants

1. Exact canonical identity only. No fuzzy entity merge in NODE-7 V1.
2. Source system identity and upstream origin identity are separate dimensions.
3. Multiple source systems sharing one upstream origin are not independent origins.
4. `OBSERVED`, `REPORTED`, and `PUBLISHED` may contribute to convergence breadth by default.
5. `SCORED` and `ENRICHED` are context-only by default and do not inflate convergence breadth.
6. Multi-source overlap does not mean confirmed, corroborated, malicious, coordinated, or causal.
7. Missing observation is not evidence of absence unless the relevant source coverage supports that claim.
8. Date precision is not converted into a fabricated midnight event timestamp.
9. Current geolocation is not historical geolocation.
10. Infrastructure location is not attacker origin.
11. ASN registration country is not automatically physical infrastructure location.
12. Co-reporting in one source record does not create a semantic relationship such as `USES`, `HOSTED_ON`, or `ATTACKED_BY`.
13. BGP announcement is not attack; withdrawal is not outage; origin change is not a hijack verdict.
14. Routing minute aggregate prefix and ASN sets must not be used to invent prefix-to-origin relationships.
15. Bootstrap, recovery and historical backfill must not manufacture current-activity novelty.
16. AI output cannot create canonical NODE-7 truth.

## Phase architecture

### NODE-7A — Contract freeze

Defines entity eligibility, source/upstream-origin semantics, observation-basis roles, temporal precision rules, geo assertion classes, discovery kinds, forbidden inference shortcuts, API boundaries and acceptance gates.

### NODE-7B — Stable entity identity and source presence

Implemented by the initial NODE-7 foundation PR:

- `technical_entity_registry`
- `node7_projection_checkpoints`
- `node7_dirty_entities`
- `entity_source_presence_revisions`
- `entity_source_presence_heads`
- `entity_source_presence_inputs`
- standalone `NODE7_WORKER`

The worker consumes newly appended entity-observation revisions through a deterministic checkpoint, marks exact canonical entities dirty and recomputes source presence from current entity-observation heads. Presence history is append-only and preserves source class, observation basis, upstream origin and semantic-contract snapshots.

### NODE-7C — Convergence and lineage

Future implementation must add immutable, versioned convergence profiles and revisioned convergence state. Initial eligible exact entity types are expected to be `CVE`, `IP`, `DOMAIN`, `URL`, `HASH`, `ASN`, and `CERTIFICATE`.

Default breadth semantics:

```text
CONTRIBUTING: OBSERVED, REPORTED, PUBLISHED
CONTEXT_ONLY: SCORED, ENRICHED
```

Expected convergence classes:

```text
SINGLE_SOURCE_SYSTEM
SAME_UPSTREAM_ORIGIN_MULTI_SYSTEM
MULTI_UPSTREAM_ORIGIN_OVERLAP
```

No confidence or threat score is part of the convergence contract.

Required lineage path:

```text
convergence revision
  -> source-presence revision
  -> entity-observation revision
  -> canonical evidence record
  -> raw source record
```

### NODE-7D — Temporal related records

Supported bounded windows are expected to be `1H`, `6H`, `24H`, and `7D`.

`INSTANT` observations retain exact instants. `DATE` observations are analytically treated as day intervals for overlap checks but remain date-precision in storage and APIs. NODE-7 V1 does not create transitive episode clusters or infer common cause from temporal proximity.

Related-record semantics are limited to exact subject occurrence and explicit co-reporting in the same canonical record. Co-reporting is not infrastructure ownership, campaign identity, causality or use relationship.

### NODE-7E — Geography assertions

The only initial geo assertion classes are:

```text
OBSERVED_INFRASTRUCTURE_LOCATION
REPORTED_TARGET
REPORTED_ACTIVITY
```

Geo is revisioned evidence, not an entity property. Each assertion requires explicit subject, basis, source/provenance, temporality and location scope.

Provider-derived current GeoIP must be labelled `CURRENT_LOOKUP`; it cannot be projected backwards as historical event location. Any external provider must pass the existing source-admission/licensing process before production collection or public derived-data display.

The world-map API and CİTEM UI must keep Infrastructure, Reported Targets and Reported Activity as separate selectable layers.

### NODE-7F — Discovery

Initial discovery kinds:

```text
NEW_TO_NODE_LIVE
FIRST_SEEN_SOURCE_TIME
MULTI_UPSTREAM_ORIGIN_CONVERGENCE
SOURCE_COMPOSITION_CHANGE
TOP_OBSERVATION_MOVER
CONCURRENT_MULTI_CLASS_MOVEMENT
```

`NEW_TO_NODE_LIVE` is valid only for a first live-incremental Node observation. Initial bootstrap, historical backfill and recovery cannot generate current novelty.

Numeric movement comparisons require compatible source population/semantics and usable coverage in both compared windows. Otherwise the comparison status is `INSUFFICIENT_COVERAGE`, `INCOMPATIBLE_SOURCE_MODEL`, or `UNSUPPORTED` and numeric deltas remain null.

### NODE-7G — Read API

Planned bounded authenticated surfaces:

```text
GET /v1/techint/convergence
GET /v1/techint/convergence/{id}
GET /v1/techint/entities/{id}/lineage
GET /v1/techint/entities/{id}/related-records
GET /v1/techint/entities/{id}/geography
GET /v1/techint/discovery
GET /v1/techint/geography/assertions
GET /v1/techint/map
```

APIs must use strict filters, bounded limits, opaque cursors, explicit semantic metadata and no raw secret/payload leakage.

### NODE-7H — CİTEM consumer

CİTEM will reuse the existing server-only BAYKUSH Node client. Planned surfaces are:

- a small Discovery Summary on Global View rather than a fourth measurement lane;
- `/techint/discovery` for convergence, novelty, composition changes, movers and concurrent movement;
- `/techint/map` with explicit geo-class layer selection;
- entity Source Presence, Convergence, Related Records, Geography and Lineage sections.

Failure domains remain isolated: NODE-7 discovery or geo failure must not hide existing vulnerability, malware/IOC or routing lanes.

### NODE-7I/J — Acceptance and closure

NODE-7 does not close until deterministic fixtures and real-data acceptance demonstrate:

- exact entity-registry parity and idempotency;
- same-origin multi-system behavior;
- multi-origin behavior;
- context-only EPSS/enrichment behavior;
- real CVE multi-origin overlap;
- complete convergence-to-raw lineage;
- date/instant precision preservation;
- geo basis/temporality correctness;
- map/assertion parity;
- source-coverage failure safety;
- restart/idempotency safety;
- CİTEM E2E and browser-token isolation.

## Routing boundary

NODE-6 high-volume routing remains a separate telemetry plane. NODE-7 must not explode every observed prefix into the generic entity-observation store and must not infer prefix-origin relationships from minute buckets that store prefix and ASN sets separately. A future routing-composition projection may be added only if the raw/derived contract preserves explicit prefix-to-origin relationships and the required state semantics.

## Definition of done for the NODE-7A/B foundation

The foundation is complete when:

- all historical entity-observation identities have a stable registry row;
- a checkpoint prevents historical revisions from being rediscovered after bootstrap;
- new observation revisions deterministically dirty their exact entity;
- dirty work is bounded, leased, retryable and restart-safe;
- source presence is revisioned and retractions are represented as `RETRACTED`, not as zero activity;
- source-system semantic snapshots include source class, observation basis, upstream origin and semantic contract version;
- every source-presence revision links to the current entity-observation revisions that produced it;
- a dedicated `NODE7_WORKER` heartbeat exists;
- no convergence score, geo inference, threat judgement or CİTEM consumer code is introduced prematurely.

# NODE-7A/B — Entity Discovery Foundation

## Scope

This phase establishes the stable entity identity and source-presence substrate required by later convergence, lineage, geography and discovery work.

It intentionally does **not** implement convergence scoring/classes, geo enrichment, discovery ranking, world-map APIs, routing-to-entity inference or CİTEM consumer UI.

## Data flow

```text
entity_observation_revisions
        |
        | deterministic checkpoint scan
        v
technical_entity_registry
        |
        v
node7_dirty_entities
        |
        | leased/retryable NODE7_WORKER
        v
entity_observation_heads
        |
        v
entity_source_presence_revisions
        |
        +--> entity_source_presence_inputs
        |
        v
entity_source_presence_heads
```

## Identity

`technical_entity_registry` gives a stable UUID to the already-authoritative `(entity_type, entity_key)` identity. Its SHA-256 is generated from:

```text
entity_type + NUL + entity_key
```

Registry rows are immutable. Retraction of observations does not delete entity identity.

The migration backfills all identities from the complete revision history, not only current heads.

## Bootstrap and checkpoint

Migration `0033` does two things atomically:

1. backfills the complete stable registry and marks each entity dirty with `HISTORICAL_BOOTSTRAP`;
2. advances `ENTITY_OBSERVATION_CURSOR` to the newest entity-observation revision already present at migration time.

This means the dedicated worker builds source-presence state for existing entities without replaying the historical observation-revision log a second time through discovery.

After bootstrap, new entity-observation revisions are consumed in deterministic `(created_at, id)` order.

## Dirty queue

`node7_dirty_entities` stores one current work item per entity. A new observation revision increments `dirty_revision`; a new source-semantic drift mark also increments it.

Claims use `FOR UPDATE SKIP LOCKED` with a bounded lease. Completion deletes the item only if the claimed `dirty_revision` is still current. If another revision dirtied the entity while it was being processed, completion releases the lease but leaves the newer dirty revision queued.

Failures use bounded exponential backoff. A genuinely new dirty revision resets attempt state so a previously exhausted entity can recover after new input arrives.

## Source presence

A source is currently present for an entity only when at least one current `entity_observation_head` for that exact entity/source is `ACTIVE`.

An active presence revision contains:

- first/last source-observed time while preserving instant vs date precision;
- first/last Node receipt time from the supporting raw records;
- active observation count;
- primary vs related observation counts;
- acquisition bases represented by active observations;
- source-class snapshot;
- observation-basis snapshot;
- upstream-origin snapshot;
- semantic-contract-version snapshot;
- deterministic input fingerprint.

If all current observations for the source/entity are retracted, a new source-presence revision is appended with:

```text
state = RETRACTED
observation_count = 0
time_precision_summary = NONE
```

The previous active revision remains immutable and carries the historical first/last/count state.

`RETRACTED` therefore means **no current active source presence**. It does not mean zero activity and it does not erase historical evidence.

## Lineage

Every source-presence revision records the current entity-observation revision IDs that produced the projection in `entity_source_presence_inputs`.

That preserves the path:

```text
entity source presence
  -> entity observation revision
  -> canonical evidence record
  -> raw source record
```

Later NODE-7 convergence revisions will reference source-presence revisions rather than bypassing this layer.

## Source semantic drift

`source_definitions` currently stores source class, observation basis, upstream origin and semantic-contract version as current source metadata. NODE-7 snapshots those fields into every presence revision.

The NODE7 worker also scans current presence heads for semantic drift. If a source definition changes those fields, affected entities are re-dirtied so a new immutable presence revision records the new semantics rather than silently mutating history.

## Time semantics

Date-only upstream observations remain date-only. The source-presence summary uses day start only as a deterministic sorting boundary internally; it does not persist or expose a fabricated midnight event timestamp.

A mixed source presence is explicitly labelled `MIXED`.

## Runtime isolation

The dedicated process is:

```text
NODE7_WORKER
```

It has its own heartbeat and queue. A NODE7 worker failure does not stop collection, normalization, historical measurements, RIPE stream collection or MRT recovery.

## Validation

The repository test suite includes deterministic contract tests for:

- stable exact identity hashing;
- contributing vs context-only observation bases;
- date/instant precision preservation;
- retraction semantics;
- primary/related observation counts;
- acquisition-basis normalization;
- order-independent source-presence fingerprints.

The normal migration harness is expected to apply `0033` and `0034` on PostgreSQL and therefore validate schema/trigger/FK syntax along with earlier migrations.

## Exit gate

Do not begin NODE-7 convergence materialization until this PR has:

- lint PASS;
- typecheck PASS;
- Vitest PASS;
- migration harness PASS;
- production TypeScript build PASS;
- production Docker build PASS;
- review confirming no fuzzy identity, threat score, attribution inference, geo inference or routing semantic shortcut was introduced.

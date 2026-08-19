# NODE-7 Discovery Policy

## New entity

`NEW_ENTITY` is based on the entity's source-effective first-seen state, not on when BAYKUSH happened to ingest a row. A history revision whose acquisition basis is `INITIAL_BOOTSTRAP`, `RECOVERY`, `HISTORICAL_BACKFILL`, or `SNAPSHOT_RECONSTRUCTION` is classified as `HISTORICAL_DISCOVERY`, not present-tense novelty.

`RESYNC` and `REPAIR` remain eligible for current classification only when the entity history itself still says the effective first-seen time is current. The finding preserves acquisition basis so the analyst can inspect the reason.

## Composition expansion

NODE-7 v1 compares one materialized HOUR/DAY activity bucket with the immediately preceding bucket of the same resolution. It records only positive additions:

- new source definitions;
- new upstream origins;
- new source classes.

The absence of a source in the current bucket is not called a removal or disappearance. Negative claims require explicit coverage-aware semantics and are deliberately deferred.

## Top movers

Top movers are not a risk ranking. They are ordered technical subjects with explainable composition expansion. Presentation should expose the component counts instead of compressing them into an opaque threat score:

1. new upstream origins;
2. new source classes;
3. new source systems;
4. latest observation time.

## Retractions and recomputation

Discovery is revisioned. Later backfill, repair or upstream retraction may change entity history or activity composition. NODE-7 appends a new discovery revision and advances the head; it never mutates or deletes the prior finding history.

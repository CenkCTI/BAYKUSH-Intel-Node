# NODE-7 — Convergence, Lineage, Geography & Discovery

## Mission

NODE-7 makes multi-source technical movement discoverable without converting correlation into attribution, attack verdicts, risk scores, or strategic conclusions.

The authoritative flow remains:

`upstream source -> raw source record -> canonical evidence -> entity observation/history -> NODE-7 derived discovery state -> authenticated read API -> CITEM analyst presentation`

NODE-7 never creates a second canonical truth model. It consumes the immutable/revisioned truth produced by earlier Node phases and adds deterministic, revisioned discovery projections.

## Non-negotiable semantics

- correlation is not causation;
- source-system count is not upstream-origin count;
- reporting volume is not attack volume;
- exact canonical identity is the NODE-7 v1 correlation boundary;
- `INSTANT` and `DATE` observations are not interchangeable;
- historical bootstrap/backfill/recovery is not current movement;
- no coverage is not zero activity;
- geolocated infrastructure is not attacker origin;
- ASN registration country is not physical infrastructure location;
- a BGP announcement is not an attack;
- a BGP withdrawal is not an outage verdict;
- RIPE RIS visibility is not complete global-Internet visibility;
- AI may explain discovery output but cannot become the canonical discovery authority.

## Layers

### L0 — canonical truth

Existing immutable/revisioned tables remain authoritative:

- `raw_source_records`;
- `canonical_evidence_records`;
- `entity_observation_revisions` / `entity_observation_heads`;
- `entity_history_revisions` / `entity_history_heads`;
- measurement and routing revision models.

### L1 — activity projection

Entity observations are materialized into bounded hour/day activity buckets. The buckets preserve source definition, upstream origin, source class, observation basis, time precision, input revision lineage, deterministic fingerprints, and revision history.

### L2 — discovery findings

Deterministic findings are derived from activity state:

- `SOURCE_SYSTEM_OVERLAP`;
- `MULTI_ORIGIN_CONVERGENCE`;
- `CROSS_CLASS_CONVERGENCE`;
- `CONCURRENT_MOVEMENT`;
- `NEW_ENTITY` / `HISTORICAL_DISCOVERY`;
- `COMPOSITION_EXPANSION`.

No finding contains an actor, attacker-country claim, maliciousness verdict, severity, threat score, or attack probability.

### L3 — analyst presentation

The Node exposes bounded authenticated read contracts. CITEM remains a server-side consumer and presents discovery with semantic boundaries and traversable provenance.

## Planned NODE-7 subphases

1. **7A Semantic Foundation** — entity capabilities, upstream-origin semantics, derivation policies, exact-identity and time/acquisition contracts.
2. **7B Entity Activity Backbone** — deterministic hour/day activity buckets, members, inputs, durable projection jobs and receipts.
3. **7C Convergence** — source-system, upstream-origin, cross-class and instant-only concurrent movement findings.
4. **7D Lineage & Related Records** — bounded related-record and evidence-lineage traversal.
5. **7E Discovery** — new entities, historical-discovery separation, composition expansion and explainable top movers.
6. **7F Geography** — explicit-basis geographic assertions and bounded map aggregates.
7. **7G Infrastructure Context** — bounded canonical-IP to RIPE routing context without attack/outage/hijack inference.
8. **7H Read API** — authenticated, bounded discovery contracts.
9. **7I CITEM Integration** — discovery summary, workbench, entity drill-down and geography presentation in a separate failure domain.
10. **7J Resilience & Performance** — replay, lease recovery, statement bounds, 30-day query load and small-host operation.
11. **7K Real Acceptance & Closure** — real multi-source convergence through Node to CITEM with machine-readable evidence.

## Authority boundary

NODE-7 can state that multiple distinct technical sources moved around the same exact canonical subject and can expose the evidence supporting that statement. It cannot state why that movement occurred, who caused it, whether an attack occurred, or what strategic action should follow.

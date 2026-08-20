# NODE-7 Convergence Semantics

## Exact subject identity

NODE-7 v1 correlates only exact canonical identities. Entity type and canonical key together define the subject. Domain/URL/IP relationships, subdomain folding, malware-family similarity, product-family equivalence, and fuzzy text matching are explicitly outside v1.

## Counts that must remain separate

For every subject/window NODE-7 keeps at least:

- contributing source-definition count;
- contributing upstream-origin count;
- contributing source-class count;
- contributing observation count.

Two source definitions may share one upstream origin. That can support `SOURCE_SYSTEM_OVERLAP` but not `MULTI_ORIGIN_CONVERGENCE`.

## Contributing evidence vs context-only data

NODE-7 convergence breadth is intentionally narrower than the complete entity-observation history.

The active `node7-convergence-v2-context-gated` policy keeps scoring/context systems visible in canonical/entity history while excluding them from convergence breadth. The initial context-only gates are:

- observation basis `SCORED`;
- source classes `EXPLOIT_PROBABILITY`, `CONTEXT_KNOWLEDGE`, and `ROUTING_TELEMETRY`;
- explicit source keys `FIRST_EPSS` and `MITRE_ATTACK_ENTERPRISE`.

This prevents an EPSS score or ATT&CK context reference from manufacturing an additional independent technical source/origin around almost every CVE or technique.

`ENRICHED` is **not** globally excluded. In the current Node source contracts, NVD CVE uses an enriched observation basis while remaining a distinct `VULNERABILITY_DATABASE` upstream. The policy therefore classifies context by the combination of source semantics rather than assuming every enriched record is merely contextual.

Context-only observations are excluded from activity-bucket breadth and convergence lineage. They remain available in the underlying canonical/entity evidence chain and may be displayed separately as context by future consumers.

## Finding types

### SOURCE_SYSTEM_OVERLAP

At least two contributing source definitions observe/report the same exact canonical entity in the selected derivation window.

Does not represent independent corroboration, causation, exploitation or coordinated activity.

### MULTI_ORIGIN_CONVERGENCE

At least two distinct contributing `upstream_origin_key` values observe/report the same exact canonical entity in the selected derivation window.

Does not represent organizational independence beyond the declared upstream-origin model and does not imply maliciousness.

### CROSS_CLASS_CONVERGENCE

At least two distinct contributing source classes observe/report the same exact canonical entity in the selected derivation window.

The semantic class of every contributing member remains visible; classes are not flattened into a generic evidence count.

### CONCURRENT_MOVEMENT

At least two distinct contributing upstream origins produce `INSTANT`-precision observations for the same exact canonical entity and their first-to-last observation span fits the active activity window.

NODE-7 v1 materializes convergence on HOUR activity buckets, so the active policy uses a conservative **1-hour concurrency contract**. It does not claim a rolling six-hour window that the current materialization does not actually compute.

`DATE` observations are never promoted into hour-level concurrency. Same-date reporting may support day-level overlap but not `CONCURRENT_MOVEMENT`.

Longer `1H/6H/24H/7D` analyst related-record windows are a separate temporal-navigation concern and do not automatically become concurrency findings.

## Acquisition basis and novelty

Current novelty/movement must not be fabricated by ingestion timing. Under the active `node7-discovery-v2-live-novelty` policy, **only `LIVE_INCREMENTAL` may produce current `NEW_ENTITY` novelty**.

The following acquisition bases remain historical/reconstructive for discovery semantics:

- `INITIAL_BOOTSTRAP`;
- `RECOVERY`;
- `HISTORICAL_BACKFILL`;
- `RESYNC`;
- `REPAIR`;
- `SNAPSHOT_RECONSTRUCTION`.

They may revise historical truth but do not become present-tense novelty merely because BAYKUSH learned or repaired them today.

## Coverage

Absence is meaningful only where the underlying source coverage allows it. NODE-7 v1 therefore emphasizes composition expansion and positive observations. It does not declare that a source/entity relationship disappeared solely because it was not observed in a current window.

## Routing boundary

RIPE RIS routing remains a separate telemetry plane. `ROUTING_TELEMETRY` is context-only for generic NODE-7 convergence breadth. BGP announcement is not attack; withdrawal is not outage; origin change is not a hijack verdict. Minute-level prefix and ASN sets must not be converted into inferred prefix-to-origin relationships.

## Forbidden derived fields

NODE-7 canonical discovery state must not include:

- actor attribution;
- attacker origin;
- victim origin inferred from infrastructure;
- maliciousness score;
- attack probability;
- global threat/risk score;
- outage verdict;
- BGP hijack verdict;
- strategic recommendation.

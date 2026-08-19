# NODE-7 Convergence Semantics

## Exact subject identity

NODE-7 v1 correlates only exact canonical identities. Entity type and canonical key together define the subject. Domain/URL/IP relationships, subdomain folding, malware-family similarity, product-family equivalence, and fuzzy text matching are explicitly outside v1.

## Counts that must remain separate

For every subject/window NODE-7 keeps at least:

- source-definition count;
- upstream-origin count;
- source-class count;
- observation count.

Two source definitions may share one upstream origin. That can support `SOURCE_SYSTEM_OVERLAP` but not `MULTI_ORIGIN_CONVERGENCE`.

## Finding types

### SOURCE_SYSTEM_OVERLAP

At least two source definitions observe/report the same exact canonical entity in the selected derivation window.

Does not represent independent corroboration, causation, exploitation or coordinated activity.

### MULTI_ORIGIN_CONVERGENCE

At least two distinct `upstream_origin_key` values observe/report the same exact canonical entity in the selected derivation window.

Does not represent organizational independence beyond the declared upstream-origin model and does not imply maliciousness.

### CROSS_CLASS_CONVERGENCE

At least two distinct source classes observe/report the same exact canonical entity in the selected derivation window.

The semantic class of every member remains visible; classes are not flattened into a generic evidence count.

### CONCURRENT_MOVEMENT

At least two distinct upstream origins produce `INSTANT`-precision observations for the same exact canonical entity and their first-to-last observation span is within the active policy window.

`DATE` observations are never promoted into hour-level concurrency. Same-date reporting may support overlap but not `CONCURRENT_MOVEMENT`.

## Acquisition basis

Current novelty/movement must not be fabricated by ingestion timing. `INITIAL_BOOTSTRAP`, `RECOVERY`, `HISTORICAL_BACKFILL`, and `SNAPSHOT_RECONSTRUCTION` are historical acquisition bases for NODE-7 discovery. They may revise history but do not become present-tense novelty merely because BAYKUSH learned them today.

## Coverage

Absence is meaningful only where the underlying source coverage allows it. NODE-7 v1 therefore emphasizes composition expansion and positive observations. It does not declare that a source/entity relationship disappeared solely because it was not observed in a current window.

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

# NODE-7 Acceptance & Closure Record

**Phase:** NODE-7 — Convergence, Lineage, Geography & Discovery  
**Status:** COMPLETE  
**Closed:** 2026-08-20

This document is the permanent closure record for the NODE-7 producer and CİTEM consumer integration. It records the implementation baselines, automated acceptance evidence, manual operational/browser acceptance, semantic boundaries, and deferred non-blocking work.

## Implementation baselines

NODE-7 producer implementation merge baseline:

- repository: `CenkCTI/BAYKUSH-Intel-Node`
- `main` merge commit: `7f5834b2438e6e21fc3cf37c0ba4fdd2650153d4`
- implementation tree: `d0109861e67d8204160ba245e4f6eaec98840f51`

CİTEM NODE-7 consumer implementation merge baseline:

- repository: `CenkCTI/CIP`
- `main` merge commit: `a75b48e71c4447f07a4113d24786dd026d583833`
- accepted pre-merge consumer head: `0bf37f4755c949ee0daace8aa40eef989bedb06f`

The Node `main` SHA may advance after this documentation-only closure work. The producer commit above is the immutable NODE-7 implementation merge baseline, not a promise that it remains the repository tip forever.

## Final producer validation

The final NODE-7 producer tree was synchronized with merged `main` without changing file content and was validated again before merge.

- synchronized validation head: `8582735e2ed13601451ab4d52b43ac903072e47a`
- tree: `d0109861e67d8204160ba245e4f6eaec98840f51`
- NODE validation run: `32316135806`
- workflow run number: `327`
- result: `SUCCESS`

The run covered:

- lint;
- TypeScript typecheck;
- unit tests;
- populated NODE-6.2 upgrade-path acceptance;
- migrations through NODE-7 semantic hardening;
- migration immutability/idempotency;
- earlier NODE regression and acceptance gates;
- NODE-7 PostgreSQL discovery acceptance;
- NODE-7 discovery compose-service validation;
- production TypeScript build;
- production Docker build including the pinned MRT decoder.

## Final producer → CİTEM acceptance

After NODE-7 producer PRs were merged into Node `main`, the CİTEM acceptance workflow was repinned to the actual merged producer commit:

`7f5834b2438e6e21fc3cf37c0ba4fdd2650153d4`

Fresh acceptance then passed against CİTEM head `0bf37f4755c949ee0daace8aa40eef989bedb06f`.

- NODE-7 CITEM real acceptance run: `32319003981`
- workflow run number: `7`
- result: `SUCCESS`
- artifact name: `node7-citem-real-acceptance`
- artifact ID: `9389116161`
- artifact digest: `sha256:472502386b13ebd46923b4a0ffbd8becfc75f1e3e1383cf4f6f6bc419b559ef2`

The acceptance gate verified:

- deterministic NODE-7 PostgreSQL semantics;
- real CISA KEV + NVD exact canonical overlap;
- bounded authenticated Node API responses;
- exact related-record basis;
- bounded lineage;
- explicit geography class handling;
- CİTEM NODE-7 consumer schema/integration behavior;
- server-side bearer credential handling;
- separated NODE-7 failure domain.

Fresh CİTEM validation also passed:

- Phase 2.1A validation run: `32319003871`
- workflow run number: `459`
- result: `SUCCESS`

## Manual populated-database acceptance

Manual local acceptance used an existing populated PostgreSQL volume rather than a clean database.

Verified:

- migration path from the pre-NODE-7 database through the final NODE-7 schema completed successfully;
- historical NODE-6 routing revisions remained immutable;
- upgrade-required routing state was appended as a new revision with `supersedes_revision_id` rather than mutating history;
- standard compose runtime started successfully, including the NODE-7 discovery worker;
- `/v1/health` returned `status: ok`;
- protected NODE-7 API authentication worked;
- `/v1/techint/discovery` returned real local discovery counts and top movers;
- `/v1/techint/convergence` returned exact-entity source-system, multi-origin, cross-class and concurrent-movement findings.

## Manual CİTEM browser acceptance

The accepted CİTEM application code was exercised against the local producer.

### Global View

Verified:

- Vulnerability & Exploitation remained Lane 01;
- Malware & IOC remained Lane 02;
- Internet Infrastructure remained Lane 03;
- NODE-7 appeared as a separate Technical convergence & discovery summary rather than a fake fourth measurement lane;
- routing copy preserved the BGP semantic guardrails;
- discovery summary exposed new entities, composition expansion, concurrent movement, cross-class convergence and composition-only top movers without threat-score language.

### Discovery Workbench

Verified with real local data:

- source-system overlap;
- multi-upstream-origin convergence;
- cross-class convergence;
- concurrent technical movement;
- `LIVE_INCREMENTAL` current novelty;
- positive composition expansion;
- explainable top movers;
- explicit geography empty state when no assertion existed.

The UI preserved that correlation does not assert causation, exploitation, attribution, or a global threat score.

### Exact entity drill-down

Manual drill-down of `CVE-2026-61712` verified:

- exact canonical related-record basis;
- GitHub reviewed advisory evidence;
- NVD CVE evidence;
- distinct upstream provenance;
- bounded evidence graph with 18 nodes and 17 edges;
- entity history, observation revisions, canonical records, raw-record references, source definitions, activity buckets and convergence revisions;
- no unsupported attribution, causation, exploitation, or threat-score claim;
- correct empty geography state when no geographic assertions existed.

## Exit criterion

NODE-7 exit criterion is satisfied:

> An analyst can see that multiple distinct technical sources moved around a common subject and drill to the evidence without the Node declaring attribution or strategic meaning.

The producer, API, CİTEM consumer, lineage path, semantic guardrails, populated upgrade path, and repeatable CI acceptance all passed.

## Semantic boundaries retained

NODE-7 closure does not weaken the following invariants:

- exact canonical identity only; no fuzzy merge;
- source system != upstream origin;
- same-upstream systems do not create false independent-origin convergence;
- scoring/context data does not inflate convergence breadth;
- convergence != corroboration, causation, exploitation, or attribution;
- `DATE` precision != hour-level concurrency;
- only `LIVE_INCREMENTAL` may create current novelty;
- bootstrap, recovery, historical backfill, RESYNC, REPAIR and snapshot reconstruction are not current novelty;
- top movers are composition movement, not threat/risk ranking;
- observed infrastructure location != attacker origin;
- current geolocation is not historical geolocation;
- BGP announcement != attack;
- BGP withdrawal != outage verdict;
- origin change != hijack verdict;
- RIPE visibility != complete global Internet visibility;
- AI output does not mutate canonical NODE-7 truth.

## Deferred non-blocking work

The following items are intentionally deferred and do not reopen NODE-7:

1. **IP-specific geography/routing browser drill-down** — not manually exercised because no suitable local geographic assertion was present. Automated producer/consumer contract coverage passed.
2. **Discovery Workbench UX density** — grouping, collapse, filtering and pagination can reduce repeated exact-entity findings in future UX work. This is presentation refinement, not a correctness gate.

## Git/PR hygiene

Authoritative NODE-7 implementation history:

- Node PRs `#31` through `#37`: merged;
- Node PR `#38`: closed without merge; duplicate alternative foundation and must never be mixed into the authoritative migration stack;
- CİTEM PR `#52`: merged.

Merged/obsolete feature branches are no longer active dependencies and may be deleted after closure:

- `agent/node7a-semantic-foundation`
- `agent/node7b-entity-activity-backbone`
- `agent/node7c-convergence-lineage`
- `agent/node7e-discovery`
- `agent/node7f-geography`
- `agent/node7gh-read-api`
- `agent/node7jk-acceptance`
- duplicate/closed `agent/node7ab-entity-discovery-foundation`
- CİTEM `agent/techint-node7-discovery`

Merged and closed PRs should remain intact as historical audit evidence; they are not active roadmap dependencies.

## Next phase

NODE-8 — Operational Hardening is the next roadmap phase.

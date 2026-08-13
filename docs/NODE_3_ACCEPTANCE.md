# NODE-3 Acceptance Contract

NODE-3 is accepted only when historical technical measurement remains explicit about source semantics, coverage, uncertainty, revisions and provenance.

## Automated gates

The pull request must pass:

1. ESLint.
2. Strict TypeScript typecheck.
3. Full unit test suite.
4. Migrations 0001 through current NODE-3 migration.
5. Migration idempotency/immutability acceptance.
6. NODE-1 runtime acceptance.
7. NODE-2A through NODE-2G acceptance.
8. NODE-2G resilience acceptance.
9. NODE-2G final/security audits.
10. `NODE3_MEASUREMENT_ACCEPTANCE_V1`.
11. `NODE3_FINAL_AUDIT_V1`.
12. `NODE3_SECURITY_AUDIT_V1`.
13. NODE-3 compose validation.
14. TypeScript build and container build.

## Historical truth invariants

- Date-only facts retain date precision.
- Bucket math is UTC and half-open.
- No coverage never becomes numeric zero.
- Bootstrap/manual/backfill does not prove live historical coverage.
- Data availability and live coverage remain separate.
- Corrected facts append revisions rather than update history.
- Moving a corrected event marks both old and new buckets dirty.
- Duplicate delivery is idempotent.
- Superseded entity assertions may be retracted without deleting historical revisions.
- Entity first-seen may move earlier after late evidence.
- Distinct hour/day values are not sums of smaller distinct buckets.
- Comparison is coverage-gated.
- Previous zero never produces an infinite percentage.
- EPSS comparison is suppressed across incompatible model/population context.
- As-of provenance cannot admit a later fact revision into an earlier knowledge boundary.

## Source-specific invariants

### CISA KEV

`dateAdded` stays date-precision. Current catalogue reconstruction is not labelled complete historical live coverage. Update/removal observations describe changes observed by BAYKUSH, not exact upstream edit-event counts.

### NVD

Publication and last-modified timelines remain separate. Last-modified acquisition windows do not falsely establish complete publication-time coverage.

### FIRST EPSS

Population remains explicitly `EPSS_HIGH_SIGNAL_V1`; score composition never claims full global EPSS population coverage.

### ThreatFox

Report volume remains source reporting volume. Distinct indicators use normalized identities. Recovery outside the admitted recent horizon remains a gap.

### MalwareBazaar

Sample reporting remains repository reporting. Distinct SHA-256 identities are exact. Historical gaps outside the admitted 60-minute metadata surface remain explicit.

## Core outage scenario

For a source with expected polls at 09:00, 09:15, 09:30, 09:45, 10:00 and 10:15, if 09:30 and 09:45 have no valid collection and cannot be historically recovered, the historical series must expose gaps/nulls for those intervals. It must never expose fabricated zero activity.

If a source later recovers source-supported historical evidence, data availability may become available while original live coverage remains missing.

## Live-stack gate

Before merge, the real Node deployment must demonstrate:

- migrations apply cleanly;
- the measurement runtime heartbeats;
- projection, coverage and dirty-bucket queues drain;
- five production sources remain healthy under Node authority;
- API measurement/coverage/comparison/provenance smoke requests succeed;
- restart does not create duplicate facts or aggregate revisions;
- final/security audits remain accepted after restart;
- legacy CİTEM collectors remain paused.

## Merge rule

PR #10 remains draft until the live-stack gate passes. CI success alone is necessary but not sufficient for merge.

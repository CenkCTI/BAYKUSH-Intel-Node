# NODE-6 Acceptance

NODE-6 is not complete merely because a RIPE chart renders.

## Required gates

- RIPE source admission is present and disabled by default.
- STREAM sources are never scheduled as polling work.
- stream worker heartbeat is independent from poll worker health.
- capture profiles are immutable/versioned and comparison-gated.
- one UPDATE containing N announced and M withdrawn prefixes produces one update-message observation, N announcement-prefix events and M withdrawal-prefix events.
- duplicate stream delivery cannot double-count a closed bucket.
- database/backpressure loss creates an explicit gap instead of silent dropping.
- no coverage produces NULL, never fabricated zero.
- complete coverage with no matching messages may produce valid zero.
- source-observed time remains distinct from Node receive time.
- exact distinct prefix/ASN aggregation never sums child distinct counts.
- planned MRT recovery never claims repaired availability; decoder execution is a NODE-6.2 gate.
- raw payload expiration preserves manifest/fingerprint/provenance.
- existing polling sources continue while the stream worker is stopped.
- security/final audits report no stream payload exposure through public APIs.

## Real-stack sequence

1. discover and freeze an RRC capture profile;
2. enable `RIPE_RIS_BGP` explicitly;
3. observe subscription acknowledgement and stream traffic;
4. persist bounded segments;
5. materialize one-minute buckets and coverage;
6. publish 1m/5m/hour/day routing measurements;
7. force a controlled disconnect and verify gap semantics;
8. verify bounded MRT planning remains distinct from live coverage and cannot claim repair;
9. restart the stream worker and verify no duplication;
10. run final/security audits before merge.

## Accepted implementation evidence

- A 2026-08-16 pre-fix full-profile run proved that one timer-triggered batch per second imposed an artificial persistence ceiling: the queue reached exactly 50,000 messages and failed closed. The continuous single-consumer drain pump then sustained one uninterrupted 23-RRC session for 615.9 seconds: 2,630,057 messages persisted, sampled receive/persist rates were 4,213/4,222 messages per second, the lifetime queue maximum was 5,000 messages, and no backpressure/provider/database event occurred. This is laptop acceptance evidence, not a production-capacity claim.
- Raw-retention behavior is accepted with bounded deterministic tests and an isolated rollback-only PostgreSQL fixture: expired payloads are removed while manifests, routing deltas and measurement history remain unchanged.
- Complete DAY aggregation is accepted deterministically from 1,440 compatible minute inputs. Counts are summed and distinct prefix/ASN values are exact unions; missing minutes or mixed capture populations suppress numeric output.

## Deferred NODE-6.2 gate

MRT binary decoding/projecting is intentionally outside NODE-6 v1. NODE-6.2 must select a maintained parser, verify its license and native-runtime security posture, pin decoder version/checksum and arguments, preserve deterministic normalized provenance, and accept fixtures before planned work can become repaired availability. Live RIS and MRT remain the same upstream origin.

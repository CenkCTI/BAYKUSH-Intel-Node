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
- MRT recovery creates a revision and preserves the original live-coverage state.
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
8. execute bounded MRT recovery and verify revised availability;
9. restart the stream worker and verify no duplication;
10. run final/security audits before merge.

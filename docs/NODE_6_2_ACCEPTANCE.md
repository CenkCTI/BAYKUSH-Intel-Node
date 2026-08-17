# NODE-6.2 acceptance

NODE-6.2 is accepted only when all of the following are true.

## Decoder and semantics
- BGPKIT Parser version/tag/commit are pinned and admission rationale is documented.
- Official RIPE `updates.*.gz` artifact decodes through `NODE6_2_MRT_DECODER_V1`.
- One physical UPDATE with 3 announcements + 2 withdrawals yields `1 / 3 / 2`, not five updates.
- IPv4, IPv6, AS4, AddPath-capable input and withdrawal fixtures are accepted; terminal AS_SET cannot invent a single origin.
- Corrupt/truncated input, invalid JSONL, decoder timeout/non-zero exit and output bounds fail closed.

## Acquisition and provenance
- Arbitrary operator URLs are impossible; Node generates an exact RIPE HTTPS URL from trusted RRC/time metadata.
- Download is streaming and bounded by timeout, compressed-size, redirect-host and disk-watermark controls.
- Artifact URL and SHA-256 are independent identities; changed bytes at the same URL append new provenance.
- Decoder name/version/upstream commit, binary SHA, contract, args, artifact SHA, counters, exit status and output SHA are persisted.
- Raw MRT expiry does not delete URL/hash/decoder/delta/revision/measurement lineage.

## Recovery correctness
- Request population comes from a frozen capture-profile revision. Profile changes split work.
- Missing expected RRC => PARTIAL; parser/record rejection => DEGRADED; neither can promote numeric COMPLETE.
- Fully decoded expected RRC with no updates can produce an observed zero for that RRC/minute.
- Same plan/artifact/decode/projection replay is idempotent.
- Live partial data and full MRT data are never added together.
- Complete recovery creates an immutable `MRT_RECOVERY` routing revision and preserves the prior LIVE_STREAM revision.
- Original live collection coverage is still visible after recovery; recovered availability cannot rewrite it.
- A LIVE_STREAM COMPLETE minute is not automatically replaced.

## Measurements and API
- 1m -> 5m -> hour -> day rematerialization runs after promotion.
- Mixed live/recovered parent buckets retain numeric values only when every child is complete/available/profile-compatible and expose `MIXED` acquisition provenance.
- Distinct prefixes/origin ASNs use exact set unions.
- Consumer-facing metadata can distinguish `liveCollectionCoverage` from recovered `dataAvailability`/`acquisitionBasis`.

## Resilience and security
- Segment claims use leases and are reclaimable after worker crash.
- Retry is bounded and only retryable failures are scheduled.
- Recovery runs separately from live stream ingestion and does not cause stream backpressure in acceptance soak.
- Worker uses non-root runtime, bounded staging storage, no Docker socket and direct process spawn without shell.
- Final audit reports zero orphan artifacts/decoder runs/deltas, zero PROJECTED-without-successful-decoder, zero successful request with missing RRC, zero MRT promotion without COMPLETE recovery, zero profile mismatch and zero duplicate projection fingerprint.
- CI is green.

## Operational acceptance results (2026-08-17)

Gate A, independent parser parity, passed using the same official `rrc00` artifact at `updates.20240101.0000.gz` (SHA-256 `25c7c8cdf797dcf03b3f6a40b5b8264827bedc2ed0d99b33204ce4cd34954313`). The production BGPKIT Parser 0.18.0 wrapper and CAIDA libBGPStream/bgpreader 2.1.0 produced identical announcement/withdrawal prefix-event counts, prefix sets, A/W peer sets, timestamp range, and IPv4/IPv6 distributions. `libBGPStream` element count is not a physical BGP UPDATE-message count and is intentionally not compared with `updatesDecoded`. Run `npm run test:node6-2-cross-parser`; retained evidence is `docs/acceptance/NODE_6_2_CROSS_PARSER_ACCEPTANCE.json`.

Gate B, real PostgreSQL recovery, passed against an isolated PostgreSQL 16 database. Run migrations, provide the locked decoder through `RECOVERY_DECODER_PATH`, set `NODE6_2_REAL_DB_ACCEPTANCE_CONFIRMED=true`, and run `npm run test:node6-2-real-db`. The harness exercises the official HTTPS fetch, SHA/gzip validation, production decode/projection/promotion path, immutable live history, no-double-counting, late-live guards, replay, changed-SHA lineage, missing-RRC and valid-zero controlled persistence, 1m/5m/hour/day production rematerialization, and the public read-model fields. Retained evidence is `docs/acceptance/NODE_6_2_REAL_DB_E2E_ACCEPTANCE.json`.

Gate C, live/recovery isolation, passed with the actual RIPE RIS Live collector over three approximately 60-second phases: live-only baseline, concurrent real MRT recovery, and post-recovery live collection. The live queue repeatedly drained to zero, recovery completed in one attempt, and no disconnect/backpressure/database-unavailable/forced-terminate event occurred. Stale and restored heartbeat fixtures verified recovery yield and resume. `npm run test:node6-2-soak-evidence` validates retained database telemetry for an operator-run soak; retained evidence is `docs/acceptance/NODE_6_2_LIVE_RECOVERY_SOAK_ACCEPTANCE.json`. This Internet-dependent soak is intentionally not part of normal CI.

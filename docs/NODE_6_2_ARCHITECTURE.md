# NODE-6.2 — RIPE MRT Historical Recovery & Replay

## Mission

NODE-6.2 repairs bounded gaps in the existing `RIPE_RIS_BGP` telemetry lane by replaying official RIPE RIS `update.*.gz` MRT artifacts. It is **not a new intelligence source**. RIS Live and RIS MRT have the same upstream origin, `RIPE_RIS`, and must never be counted as independent corroboration.

Pipeline:

`live gap -> frozen request/profile/policy -> official MRT artifact -> bounded fetch -> SHA-256 evidence -> pinned decoder -> message-level validation -> per-RRC/per-minute recovery deltas -> completeness proof -> immutable MRT_RECOVERY routing revision -> measurement rematerialization`

## Semantic invariants

- MRT recovered data does not mean BAYKUSH had live connectivity during the interval.
- Original live coverage/evidence is append-only truth and is never rewritten.
- A recovered minute may become data-available while its `live_collection_coverage_status` remains `PARTIAL`, `DEGRADED`, or `NO_COVERAGE`.
- Recovery never adds live partial counts to a complete MRT reconstruction. A complete MRT reconstruction is a replacement data revision, not an additive stream.
- Missing RRCs, parser failures, corrupt gzip, resource-limit failures, or unknown profile membership can never become numeric zero.
- A valid decoded artifact with no UPDATE for a minute may contribute a real zero for that RRC; the global minute is numeric only when every RRC in the frozen capture profile is proven projected.
- BGP UPDATE != incident; announcement != attack; withdrawal != outage; origin change != hijack.
- `bview`/RIB reconstruction, route-state analytics, hijack/leak/outage judgement, RPKI judgement, geolocation, attribution, RouteViews corroboration, and AI anomaly detection are out of scope.

## Frozen population and policy

Every executable recovery request references the capture-profile revision that was authoritative for the target interval. Profile transitions split requests rather than blending observer populations. `NODE6_2_RECOVERY_POLICY_V1` bounds automatic gaps to 30 minutes, manual requests to 6 hours, plans to 10,000 MRT segments, and begins with decoder/projector concurrency 1. Automatic recovery remains disabled by default until manual acceptance is complete.

The plan fingerprint covers source, requested interval, capture-profile revision, sorted RRC population, every internally generated RIPE URL, and policy revision. Operators provide time range/profile/reason only; arbitrary URLs are not accepted.

## Artifact trust boundary

Only HTTPS artifacts on the exact `data.ris.ripe.net` host and the deterministic RIPE path schema are admitted. Downloads are streamed to a UUID-derived staging key, hashed while streaming, bounded by timeout/size/disk-watermark limits, and never loaded wholly into memory or persisted as PostgreSQL `bytea`. URL identity and artifact SHA identity are separate. If the same official URL later returns different bytes, both artifact identities remain auditable and an `ARTIFACT_CHANGED` event is emitted.

Raw `.gz` files have bounded retention. URL, SHA-256, byte size, HTTP metadata, decoder provenance, per-minute deltas, routing revisions and measurements survive artifact expiry.

## Decoder trust boundary

The production decoder is a small `baykush-mrt-decoder` wrapper around **BGPKIT Parser 0.18.0**, pinned to upstream tag `v0.18.0` / commit `c39e39037ccf44de2848e9f48ba82d418d745743`. The wrapper does not implement RFC 6396 itself. It accepts only an existing absolute local file, rejects URLs, emits `NODE6_2_MRT_DECODER_V1` JSONL, and uses BGPKIT's message-level update iterator so one physical BGP UPDATE remains one `update_message_count` even when it contains multiple announced/withdrawn prefixes.

The Node process launches the fixed decoder binary directly with an argv array (`shell: false`). Decoder output is streamed through strict validation and per-minute accumulation. Terminal `AS_SET`/confederation semantics do not fabricate a definitive origin ASN, matching the existing RIS Live projection rule.

## Completeness and promotion

Recovery provenance is physically separate from live stream segment lineage (`routing_recovery_minute_deltas`). `routing_recovery_minute_revisions` proves expected/projected/missing RRC populations and carries artifact/decoder/projection fingerprints.

Only `COMPLETE + AVAILABLE` recovery may be promoted. Promotion inserts a new immutable `routing_minute_bucket_revisions` row with `acquisition_basis='MRT_RECOVERY'`; it supersedes the current data head but never updates/deletes the original LIVE_STREAM revision or stream coverage rows. A LIVE_STREAM minute already COMPLETE is not automatically replaced; MRT may be used later for parity/audit only.

Higher 5m/hour/day measurements may remain numeric when all constituent minute heads are complete, available and profile-compatible. Their acquisition summary must be `LIVE_STREAM`, `MRT_RECOVERY`, or `MIXED`; exact distinct prefix/ASN unions remain exact unions rather than sums of child distinct counts.

## Runtime isolation

A separate `recovery-worker` owns historical fetch/decode/project work. It claims PostgreSQL jobs with `FOR UPDATE SKIP LOCKED`, leases each claim, begins at concurrency 1, and yields when live stream health is degraded. It is non-root in the production container, has no Docker socket, receives a bounded staging volume, and does not execute shell commands. Recovery is lower priority than live collection.

## Attribution

RIPE provenance and attribution remain attached to every recovered lineage: **RIPE NCC Routing Information Service (RIS)**. Commercial/public presentation continues to obey the current source-admission restrictions; NODE-6.2 does not broaden redistribution rights.

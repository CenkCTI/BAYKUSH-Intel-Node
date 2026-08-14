# NODE-6 — Internet Infrastructure Telemetry

## Mission

NODE-6 adds a second ingestion class to BAYKUSH Intelligence Node: bounded continuous stream telemetry. The first production telemetry source is RIPE RIS BGP. Poll/snapshot collection remains isolated and authoritative for existing sources.

## Pipeline

`RIPE RIS Live -> stream worker -> bounded queue -> immutable segment manifest/payload -> routing segment delta -> exact one-minute micro-bucket -> 5m/hour/day measurement -> authenticated Node API`

RIPE MRT update files are a second acquisition channel for the same `RIPE_RIS` upstream origin. MRT recovery may repair data availability; it never rewrites history to claim that BAYKUSH had live coverage during a gap.

## Non-negotiable semantics

- BGP UPDATE count != routing incident count.
- Announcement observation != attack.
- Withdrawal observation != outage.
- Origin change != hijack verdict.
- Peer-down event != Internet failure.
- RIPE RIS visibility != complete global Internet visibility.
- Observer-population change != Internet activity change.
- No stream coverage != zero routing activity.
- MRT-recovered availability != live collection coverage.
- Infrastructure location != attacker origin.
- Measurement != analysis.

## Time model

NODE-6 introduces `SOURCE_OBSERVED_TIME`: the time the upstream route collector observed the BGP message. It remains distinct from Node receive time and calculation time.

## Population model

Every published routing measurement is bound to a versioned capture profile. RRC population or subscription changes create a new profile/version or suppress comparison. A metric must never silently widen its observer population.

## Storage model

Raw stream messages are stored only in bounded compressed segments. Long-lived segment manifests, fingerprints and derived aggregates survive raw-payload expiration. NODE-6 does not write one SQL row per WebSocket message and does not force the firehose through the low-volume canonical evidence envelope.

## Coverage

Public coverage states remain `COMPLETE`, `PARTIAL`, `DEGRADED`, and `NO_COVERAGE`. Known loss, schema rejection or backpressure cannot be represented as a valid zero.

## Out of scope

NODE-6 does not declare BGP hijacks, outages, DDoS, attacker/victim geography, attribution, geopolitical meaning, business risk, global threat level or AI judgement. Cross-source convergence and geography remain NODE-7 work.

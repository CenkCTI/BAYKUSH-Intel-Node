# NODE-6 — Internet Infrastructure Telemetry

## Mission
NODE-6 adds a second ingestion class to BAYKUSH Intelligence Node: bounded continuous stream telemetry. The first production telemetry source is RIPE RIS BGP. Poll/snapshot collection remains isolated and authoritative for existing sources.

## Pipeline
`RIPE RIS Live -> stream worker -> bounded queue -> immutable segment manifest/payload -> routing segment delta -> exact one-minute micro-bucket -> 5m/hour/day measurement -> authenticated Node API`

RIPE MRT update files are a second acquisition channel for the same `RIPE_RIS` upstream origin. The repository contains a bounded, allowlisted five-minute MRT recovery planner. Full MRT binary decoding/projecting remains a separate guarded execution gate; a planned recovery must not be marked as repaired until decoded evidence has been projected and audited.

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

## Time and population
NODE-6 introduces `SOURCE_OBSERVED_TIME`: the time the upstream route collector observed the BGP message. It remains distinct from Node receive time and calculation time. Every numeric routing bucket requires exactly one compatible capture-profile revision; missing or mixed profile state suppresses the value.

## Storage and retention
Raw stream messages are stored only in bounded GZIP segments. Long-lived segment manifests, fingerprints and derived aggregates survive raw-payload expiration. Payload rows are partition-ready by expiry time and purged in bounded retention batches. NODE-6 does not write one SQL row per WebSocket message and does not force the firehose through the low-volume canonical evidence envelope.

## Coverage
Public coverage states remain `COMPLETE`, `PARTIAL`, `DEGRADED`, and `NO_COVERAGE`. Known loss, schema rejection, missing capture population or backpressure cannot be represented as a valid zero.

## Out of scope
NODE-6 does not declare BGP hijacks, outages, DDoS, attacker/victim geography, attribution, geopolitical meaning, business risk, global threat level or AI judgement. Cross-source convergence and geography remain NODE-7 work. CİTEM Global View integration is a separate downstream repository change after Node acceptance.

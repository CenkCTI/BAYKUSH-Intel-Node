# NODE-4 — CİTEM Integration & TechINT Global View v1

NODE-4 makes CİTEM a server-side analyst client of BAYKUSH Intelligence Node while preserving Node as the single authority for public/global technical collection and measurement truth.

Core boundaries:

- Node remains collection authority for CISA KEV, NVD CVE, FIRST EPSS, ThreatFox, and MalwareBazaar.
- Legacy CİTEM collectors remain paused unless an explicit manual NODE-2G rollback is performed.
- CİTEM consumes Node through a versioned authenticated HTTP API; it never receives Node database credentials.
- Private CİTEM investigations, notes, evidence, attribution, products, and analyst judgements do not automatically flow to Node.
- Historical acquisition uses backfill-owned state and may never rewind or mutate live source checkpoints.
- Unknown is not zero; no coverage is not no activity; reporting volume is not attack volume.
- Global View renders Node measurement truth directly instead of recomputing the same global metrics inside CİTEM.
- The existing deterministic CİTEM anomaly layer is optional and cannot be a prerequisite for Global View.

Planned implementation sequence:

1. NODE-4A — authenticated/versioned API integration boundary.
2. NODE-4B — collector-side historical acquisition executor with checkpoint isolation.
3. NODE-4C — complete bounded TechINT read API for sources, status, summary, changes, records, entities and provenance.
4. NODE-4D — server-only CİTEM Node client with runtime schema validation, timeout, bounded retry and freshness handling.
5. NODE-4E — `/techint/global` with 24H/7D/30D controls, source-health/coverage, Vulnerability & Exploitation, Malware & IOC.
6. NODE-4F — What Changed, bucket/entity/provenance drill-down, and legacy-collector authority guard.
7. NODE-4G — real-stack end-to-end acceptance.

NODE-4 is complete only when a first-time CİTEM user can see retained Node history, CİTEM can remain closed while Node continues collection, backfill cannot mutate live checkpoints, coverage gaps remain explicit, and a Node outage cannot silently reactivate legacy CİTEM collection.

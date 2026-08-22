# NODE-8G — Observability and operations

## Mission

Make production degradation visible without confusing infrastructure/collection health with cyber-threat meaning. Operations telemetry must answer whether Node can collect, process, store, back up and serve its data; it must never be presented as an attack/threat score.

## API health planes

`GET /v1/health` remains public and intentionally minimal for reverse-proxy/liveness checks.

`GET /v1/ops/health` requires `ops:read`. It exposes bounded operational state:

- database reachability/time;
- active runtime component heartbeat ages/freshness;
- enabled source collection health and timestamps;
- bounded failure classes/counters already present in source health;
- explicit semantic disclaimers.

The operations credential is separate from CİTEM's normal `techint:read`/`sources:read` credential in the example registry.

## API heartbeat model

The NODE-8C API database principal is deliberately read-only. Production therefore does **not** weaken DB least privilege merely so API can update `runtime_heartbeats`. The production API uses active `/v1/health` probes instead. Development may retain the historical DB heartbeat behavior.

Write-authorized long-lived worker planes continue durable DB heartbeats. NODE-8G adds `DISCOVERY_WORKER` so discovery/convergence/geography projection freshness is no longer invisible.

A missing/stale heartbeat means the component is absent, stale or unable to report. It does not mean zero workload, zero incidents or healthy upstream data.

## Host operations snapshot

`ops-snapshot.sh` creates `NODE8_OPS_SNAPSHOT_V1` evidence from the host boundary:

- Compose container state/health;
- API active probe;
- disk utilization;
- latest encrypted backup age;
- threshold-derived `HEALTHY`, `DEGRADED` or `CRITICAL` state;
- explicit `containsSecrets: false` assertion.

Initial defaults:

- disk warning at 80%;
- disk critical at 90%;
- backup stale after 8 hours (compatible with the 6-hour backup target plus scheduling margin).

Thresholds are operational defaults, not semantic intelligence thresholds.

## Structured failure semantics

Provider/network failures keep their existing controlled classes (`RATE_LIMITED`, timeout/transport/provider/schema failures). Source health records last attempt/success/failure and consecutive failures. NODE-8G reads those durable records rather than reconstructing a threat narrative from log strings.

Future external alerting should trigger on stable classes such as:

- stale worker heartbeat;
- enabled source with stale/failed collection state;
- repeated upstream schema/provider failures;
- backup age over threshold;
- disk pressure;
- unhealthy/restarting container;
- TLS/edge failure.

Alert delivery mechanism is intentionally provider-independent and can be wired later without changing Node intelligence semantics.

## Acceptance

NODE-8G is accepted when:

- `ops:read` is required independently from CİTEM read scopes;
- production API health does not require DB write privilege;
- all long-lived write-authorized worker planes have observable heartbeat behavior, including discovery;
- source health remains collection-health semantics only;
- host snapshot reports disk/container/API/backup status without secrets;
- stale/missing state remains unknown/degraded rather than zero;
- all previous regression gates remain green.

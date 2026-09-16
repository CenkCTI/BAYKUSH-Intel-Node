# NODE-8I fault, load, and resilience acceptance

NODE-8I supplies deterministic engineering evidence for bounded faults and read-only load. It does not change intelligence semantics and it is not equivalent to Oracle or other real-host acceptance.

## Safety and semantic contract

The authoritative `NODE8_FAULT_MATRIX_V1` matrix is `deploy/production/acceptance/fault-matrix.json`. Fault automation never removes volumes, truncates tables, drops schemas, wipes queues, changes a host firewall, reboots a host, or overwrites backup repositories. The service harness requires `NODE8_FAULT_ACCEPTANCE_CONFIRM=YES`, root, an explicit environment/Compose context, and uses bounded stop/start operations only. `FULL` does not authorize host-destructive injection.

All evidence preserves these meanings: unknown is not zero; no coverage is not no activity; reporting volume is not attack volume; a BGP UPDATE is not an incident, attack, outage, or hijack; and geography is context, not attacker origin. A failed acquisition cannot advance a successful checkpoint or fabricate successful coverage. Recovery must retain raw/canonical provenance and durable state.

## Automated and manual coverage

The matrix defines 20 scenarios. Fourteen are automated or safe service scenarios and six require manual real-host evidence. Deterministic tests cover DNS, timeout, HTTP 429, HTTP 5xx, malformed/schema-changed provider data, 401, 403, rate-limit 429, matrix-negative cases, load timeouts, and exceeded thresholds. The safe harness covers PostgreSQL, API, worker, discovery, stream-worker, and Caddy stop/start recovery, observes the stopped state, waits for API recovery, and verifies baseline raw, canonical, normalization/provenance-supporting, and checkpoint rows were not deleted.

Run local deterministic acceptance:

```sh
npm run test:node8i
npm run test:node8i:aggregate
```

Run safe service acceptance only on an isolated production-style stack:

```sh
sudo NODE8_FAULT_ACCEPTANCE_CONFIRM=YES \
  ENV_FILE=/etc/baykush/runtime.env \
  COMPOSE_FILE=/opt/baykush-node/compose.yml \
  FAULT_MATRIX=/opt/baykush-node/acceptance/fault-matrix.json \
  /opt/baykush-node/scripts/fault-acceptance.sh
```

The harness emits `NODE8_FAULT_ACCEPTANCE_V1`. A failed recovery is `FAIL`; it can never emit accepted automated evidence.

## Bounded read-only load

The load runner accepts only HTTPS targets and the allow-listed read-only measurement catalog, sources, and operations-health paths. Credentials must be supplied with `NODE8_LOAD_TOKEN_FILE`; token text is never a command-line option or output. Defaults are 100 requests, concurrency 5, 15-second request timeout, p95 at most 2000 ms, and error rate at most 1%. Requests are capped at 10,000 and concurrency at 100.

```sh
NODE8_LOAD_BASE_URL=https://node.example.com \
NODE8_LOAD_TOKEN_FILE=/run/secrets/load-read-token \
NODE8_LOAD_REQUESTS=100 NODE8_LOAD_CONCURRENCY=5 \
node scripts/node8-load-acceptance.mjs > node8-load-evidence.json
```

`NODE8_LOAD_ACCEPTANCE_V1` reports total/successful/failed requests, status counts, timeout/transport/HTTP errors, concurrency, duration, request timeout, p50/p95/p99, error rate, and thresholds. Threshold failure exits nonzero. These are conservative NODE-8 engineering acceptance thresholds—not contractual SLA, intelligence-quality metrics, threat metrics, or coverage claims. Load reads must not mutate provenance or checkpoints, and API database least privilege remains authoritative.

## Aggregate evidence and limitations

`scripts/node8i-acceptance.mjs` emits `NODE8I_RESILIENCE_ACCEPTANCE_V1` and distinguishes `AUTOMATED_ACCEPTED`, `MANUAL_PENDING`, `FAILED`, and `NOT_EXECUTED`. Optional safe-fault and load evidence can be consumed with `NODE8I_FAULT_EVIDENCE_FILE` and `NODE8I_LOAD_EVIDENCE_FILE`. Missing environment-dependent evidence remains `NOT_EXECUTED`, never accepted.

VM restart, Docker-daemon restart, true Internet outage, true backup-target outage, real disk pressure, and a full replacement-host restore drill remain `MANUAL_PENDING`. NODE-8J must execute them on the designated disposable Oracle production-like host and record real evidence. NODE-8I local/CI results must not be presented as that evidence.

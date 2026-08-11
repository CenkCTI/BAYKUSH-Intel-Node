# NODE-1 — Runtime Backbone

## Purpose

NODE-1 implements the first source-agnostic long-running runtime beneath the NODE-0 contracts. It deliberately does not add production cyber-intelligence sources.

## Runtime components

- `api` — bounded operational HTTP surface; NODE-1 exposes only `GET /v1/health`.
- `scheduler` — turns due source schedules into idempotent collection runs.
- `worker` — claims one leased run/work unit, performs bounded work, persists raw truth and checkpoint atomically, then either queues the next bounded unit or finalizes the run.
- PostgreSQL — durable source registry, schedule state, collection lifecycle, checkpoints, raw revisions, source health and heartbeats.

All three Node processes may be restarted independently.

## Safety invariants implemented

1. Cursor/checkpoint state is updated in the same transaction as accepted raw records and work completion.
2. A worker must still own both run and work-unit leases before it may commit fetched results.
3. Identical redelivery is idempotent on `(source, source_record_id, payload_sha256)`.
4. A changed upstream payload for the same source record remains a separate raw revision.
5. Raw records cannot be updated in place.
6. Failed work never advances the checkpoint.
7. Retryable failures requeue the same work unit up to a bounded attempt count.
8. Stale `RUNNING` leases are reclaimable.
9. Scheduler refuses to create another active scheduled run for a source already `QUEUED` or `RUNNING`.
10. A first/restarted scheduler regains current collection without synthesizing missed historical activity; provider-specific historical recovery remains a later adapter responsibility.
11. Test data is disabled by default and semantically marked `UNKNOWN`/internal-test.
12. Raw payload bytes and records per work unit are hard bounded.

## Database model

Migration `0001_node1_runtime_backbone.sql` creates:

- `source_definitions`;
- `source_schedule_state`;
- `collection_runs`;
- `collection_work_units`;
- `source_checkpoints`;
- `raw_source_records`;
- `source_health`;
- `runtime_heartbeats`.

The migration seeds `TEST_SYNTHETIC` disabled by default.

Migration files are checksummed in `node_schema_migrations`; modifying an already-applied migration causes migration startup to fail closed.

## TEST_SYNTHETIC

The deterministic test adapter exercises the runtime without claiming real cyber activity. With the default development configuration, one run contains 25 records split into bounded pages `10 + 10 + 5`.

After each successfully committed page, the durable checkpoint advances from `nextSequence=10` to `20` to `25`. A future run begins from 25.

Set `ENABLE_TEST_SYNTHETIC=true` only for local/acceptance runs.

## Failure taxonomy

NODE-1 carries the controlled failure codes from NODE-0:

- `TRANSPORT_ERROR`;
- `TIMEOUT`;
- `RATE_LIMITED`;
- `AUTHENTICATION_ERROR`;
- `PROVIDER_ERROR`;
- `SCHEMA_ERROR`;
- `PAYLOAD_LIMIT_EXCEEDED`;
- `SOURCE_SNAPSHOT_CHANGED`;
- `INTERNAL_ERROR`.

Failure state is operational state. It is not cyber activity.

## Development runtime

```bash
cp .env.example .env
ENABLE_TEST_SYNTHETIC=true docker compose up --build
```

Then:

```text
GET http://localhost:8080/v1/health
```

The database remains internal to the Compose network except when an operator explicitly changes the Compose configuration.

## CI

The validation workflow runs:

1. dependency install;
2. ESLint;
3. strict TypeScript typecheck;
4. Vitest unit tests;
5. PostgreSQL migrations;
6. repeat migration to verify migration-runner idempotency/checksums;
7. database migration acceptance;
8. production TypeScript build;
9. Docker image build.

## NODE-1 acceptance

Before merge, CI must be green and manual acceptance should verify:

1. enable `TEST_SYNTHETIC`;
2. observe a scheduled run complete as three bounded work units;
3. observe 25 accepted/inserted raw records and checkpoint `nextSequence=25`;
4. stop/restart the worker between work units and verify it resumes without duplicate raw records;
5. let a claimed lease expire and verify a worker can reclaim it;
6. force a retryable synthetic failure in a later acceptance hardening step or database-controlled fixture and verify checkpoint does not advance;
7. call `/v1/health` and verify API/database plus runtime heartbeat metadata without credentials/secrets.

Production source adapters, canonical persistence, historical measurement generation, CİTEM integration, Internet telemetry, authentication hardening and Oracle deployment remain out of NODE-1 scope.

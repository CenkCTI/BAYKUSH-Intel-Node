# Collection & Recovery Model

## 1. Objective

The Node must collect continuously, recover deterministically after interruptions, and never confuse collection behavior with upstream cyber activity.

## 2. Collection lifecycle

A normal bounded unit follows:

```text
SCHEDULE / RECOVERY PLAN
        |
        v
CLAIM WORK
        |
        v
FETCH ONE BOUNDED UNIT
        |
        v
VALIDATE RESPONSE
        |
        v
PERSIST RAW RECORDS
        |
        v
NORMALIZE / RECORD RESULT
        |
        v
CHECKPOINT
        |
        +--> more work -> queue/claim next unit
        |
        v
FINALIZE RUN
```

Durable cursor/checkpoint advancement happens only after accepted records and required state are persisted.

## 3. Collection triggers

The runtime distinguishes why work exists:

- `SCHEDULED` — natural recurring collection;
- `MANUAL` — operator-requested synchronization;
- `TEST` — synthetic/acceptance work;
- `RECOVERY` — catch-up after a missing interval or interrupted run;
- `BOOTSTRAP` — initial population of a newly enabled source.

Trigger must survive into collection provenance. Manual/bootstrap work must not manufacture natural current-activity spikes.

## 4. Collection purposes

Trigger and purpose are separate concepts. Controlled purposes include:

- `LIVE_INCREMENTAL`;
- `INITIAL_BOOTSTRAP`;
- `HISTORICAL_BACKFILL`;
- `RESYNC`;
- `REPAIR`.

Example: a scheduled first-run snapshot may have `trigger=SCHEDULED` and `purpose=INITIAL_BOOTSTRAP`.

## 5. Bounded work

No request handler or worker action should assume an unbounded source can be completed atomically.

A work unit must have provider-appropriate bounds such as:

- maximum records;
- maximum page size;
- maximum pages per claim;
- maximum wall-clock duration;
- maximum payload bytes.

Long datasets progress by checkpointed work units.

## 6. Idempotency

The collection runtime assumes upstream redelivery and worker retries are normal.

Required behavior:

- repeated identical source record does not create duplicate canonical truth;
- repeated work-unit execution is safe;
- final run completion is idempotent;
- a crash after persistence but before acknowledgement can safely retry;
- a cursor is never advanced beyond persisted data.

## 7. Checkpoint model

Checkpoint state is source-specific but runtime-managed.

Examples:

- page/offset;
- provider cursor token;
- last modified timestamp;
- last stable source record ID;
- snapshot fingerprint/version;
- stream offset in future stream adapters.

Checkpoint payload is validated against an adapter-owned schema/version.

## 8. Downtime recovery

On restart, the scheduler compares current time, last successful state, expected schedule, and source recovery capability.

For each enabled source it determines:

1. current/live work required now;
2. whether a historical gap exists;
3. whether the gap can be recovered;
4. which recovery strategy applies;
5. which interval remains unrecoverable.

Current/live collection is prioritized so long historical backfill does not prevent the Node from regaining the present.

Historical recovery runs in bounded work behind or alongside current collection.

## 9. Recovery strategies

### Historical query

Query provider-supported historical intervals and retain their true source timestamps.

### Cursor catch-up

Continue from the last durable provider cursor until current state is reached.

### Snapshot reconstruction

Rebuild source-effective history from current or historical snapshots where legitimate. This provides data availability, not proof of continuous historical collection.

### Live only

Mark missed intervals unrecoverable. Do not synthesize zero activity.

## 10. First-run bootstrap

First-run behavior should avoid an empty product whenever upstream history exists.

The Node should:

1. establish current source state;
2. start bounded historical bootstrap according to source policy;
3. preserve source-effective timestamps;
4. mark acquisition as bootstrap/backfill;
5. expose bootstrap progress separately from live collection health;
6. never place all bootstrap records into the current activity bucket merely because they were received now.

## 11. Failure taxonomy

At minimum, collection failures should distinguish:

- `TRANSPORT_ERROR`;
- `TIMEOUT`;
- `RATE_LIMITED`;
- `AUTHENTICATION_ERROR`;
- `PROVIDER_ERROR`;
- `SCHEMA_ERROR`;
- `PAYLOAD_LIMIT_EXCEEDED`;
- `SOURCE_SNAPSHOT_CHANGED`;
- `INTERNAL_ERROR`.

Failure categories feed operational health and coverage, not cyber-activity interpretation.

## 12. Partial work

A provider response that yields some accepted records and then fails may be retained only when the runtime can accurately represent the interval/work as partial.

A partial result must never be silently promoted to `COMPLETE` coverage.

## 13. Scheduling

Schedules are source-defined and retained historically. If cadence changes, past coverage evaluation must use the schedule known for the past interval rather than today's schedule.

Intentional pause/archive is distinct from provider failure.

## 14. Concurrency

Early Node versions should prefer one active collection lease per source unless an adapter explicitly supports safe partitioning.

Leases expire and may be reclaimed. Reclamation must remain idempotent.

## 15. Operational invariant

The Node may lose collection coverage during failure, but it must not lose the ability to explain that coverage was lost.
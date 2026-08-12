# NODE-2G Resilience, Isolation & Collection-Authority Cutover

## Purpose

This is the final operational acceptance contract for NODE-2. It proves that the five admitted production TechINT sources remain safe under controlled failure, retry, process restart and collection-authority transition.

Production sources:

- `CISA_KEV`
- `NVD_CVE`
- `FIRST_EPSS`
- `THREATFOX`
- `MALWAREBAZAAR`

This gate does **not** add a sixth production source, NODE-3 history/measurement logic, CİTEM Node API consumption, host/database failover, backup restore, Oracle reboot acceptance or automatic failback.

## Runtime model

```text
SCHEDULER
   |
   v
collection_runs (QUEUED)
   |
   v
WORKER -- lease --> adapter.fetch()
   |                    |
   | success            | retryable failure
   v                    v
transaction          backoff / retry
   |                    |
   | raw evidence       +-- checkpoint MUST NOT advance
   | checkpoint
   | normalization job
   | run/work state
   v
NORMALIZER -- lease --> canonical evidence
```

Source truth is the immutable raw record. Canonical evidence is a derived projection. A normalizer failure must never delete or mutate raw provider evidence.

## Frozen invariants

NODE-2 closes only if all of the following remain true.

### F1 — Provider failure isolation

One controlled provider failure must not stop unrelated source work. The worker process remains operational and an unrelated deterministic source completes while the failing source is in backoff.

### F2 — Checkpoint safety

A failed work unit must not advance the source checkpoint revision or checkpoint JSON. Checkpoint advancement occurs only inside successful work persistence.

### F3 — Retry discipline

Retryable failures use exponential backoff bounded by configured maximums and provider `Retry-After` when present. A queued retry is not claimable before `available_at`; hot-loop retry is a blocker.

Default acceptance expectation:

```text
attempt 1 -> base delay
attempt 2 -> base * 2
attempt 3 -> terminal failure when WORKER_MAX_ATTEMPTS=3
```

### F4 — Raw-evidence preservation

A controlled normalization failure must produce a failed normalization job while leaving the raw record and its payload SHA-256 intact. No partial canonical evidence may be manufactured for that failed job.

### F5 — Lease/crash recovery

Expired `RUNNING` worker and normalizer leases are reclaimable by another instance. An unexpired lease must not be stolen. Recovery reuses the same run/work/job identity.

### F6 — Idempotency

Retry/restart/reclaim must not produce:

- duplicate active source runs;
- duplicate raw revisions for `(source_definition_id, source_record_id, payload_sha256)`;
- duplicate normalization jobs for `(raw_record_id, normalization_version)`;
- duplicate canonical records for `(raw_record_id, normalization_version, canonical_key, record_kind)`;
- orphan canonical records;
- orphan normalization jobs.

### F7 — Credential and private-workspace isolation

Provider credentials are injected only into the `worker` runtime. `api`, `scheduler`, `normalizer` and `migrate` do not receive NVD, ThreatFox or MalwareBazaar credentials.

The Node runtime must not receive CİTEM private-workspace credentials (`SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`) and must not depend on Supabase/CİTEM ingestion code.

When real provider secrets are present, the runtime security audit searches raw evidence, canonical evidence, checkpoints, work descriptors and failure state for exact secret persistence. Expected occurrences: zero.

## Automated CI gate

`npm run test:node2g-resilience` runs after NODE-2A–2G acceptance against the same ephemeral PostgreSQL service. It uses `TEST_SYNTHETIC` plus process-local adapter fault injection; no live provider secret or live provider side effect is required.

The deterministic suite proves:

1. CISA controlled provider failure enters retry/backoff;
2. CISA checkpoint is unchanged;
3. TEST_SYNTHETIC completes while CISA is backing off;
4. retry delay grows and terminates at the configured attempt ceiling;
5. normalization failure preserves raw evidence and creates no partial canonical record;
6. the failed normalization job can be repaired/reprocessed without raw duplication;
7. an expired worker lease is reclaimed and completes;
8. an expired normalizer lease is reclaimed and completes;
9. repeated scheduler enqueue attempts cannot create a second active run;
10. normalization drains and duplicate raw/canonical invariants remain zero.

After resilience, CI runs:

```text
npm run node2g:final-audit
npm run node2g:security-audit
```

and then build/container build.

## Runtime final audit

The compiled container CLI exposes:

```text
node dist/cli/node2g.js final-audit
node dist/cli/node2g.js security-audit
```

`final-audit` requires all consistency counters to be zero, including duplicate identities, orphan provenance, production normalization queued/running/failed and checkpoint lineage mismatches.

`security-audit` checks runtime CİTEM credential absence and, when provider credentials are configured in the worker, exact-secret persistence in Node state.

## Live Docker restart gate

Run only on the accepted local NODE-2G stack after the current branch has been rebuilt.

```text
bash scripts/node2g-live-restart-gate.sh
```

The operator gate records source status, runs a pre-audit, restarts `scheduler`, `worker` and `normalizer` one at a time, waits for heartbeat recovery, records source status again, reruns the final audit and runs the worker credential-persistence audit.

This is a non-destructive service restart gate. PostgreSQL is intentionally not restarted here; host/DB failover, backup restore and reboot acceptance remain NODE-8.

## Parity snapshot freeze hardening

Parity export supports an explicit `capturedAt`. Node raw revision selection now enforces:

```text
received_at <= capturedAt
created_at  <= capturedAt
```

before selecting the latest revision per source identity. This prevents a revision received after the frozen acceptance capture from leaking into an earlier snapshot.

Runtime CLI form:

```text
node dist/cli/node2g.js export-node \
  <SOURCE_KEY> <snapshot-id|-> <windowStart> <windowEnd> <capturedAt>
```

For moving sources, the window remains source-native (`first_seen` for ThreatFox/MalwareBazaar; NVD `lastModified`) while `capturedAt` freezes the Node revision timeline.

## Collection-authority cutover

Cutover happens only after:

- CI is green;
- all five live parity gates are accepted;
- live Docker restart/isolation gate is accepted;
- final DB audit is accepted;
- worker credential persistence audit is accepted;
- CİTEM has no active run for the five legacy collectors.

### Pre-cutover evidence

For each CİTEM source connection capture:

- connection ID;
- source key;
- status;
- cursor version;
- cursor SHA-256;
- interval;
- next run time;
- last started/succeeded/failed times;
- run-history count.

Raw cursor JSON may be stored only in a local operator snapshot outside the repository. The Git report records only non-secret metadata and cursor hashes.

### Drain rule

Do not pause a CİTEM connection with an active `RUNNING` collection. The cutover operator must observe zero active runs for all five connections first.

### Pause rule

Legacy CİTEM collectors transition:

```text
ENABLED -> PAUSED
```

Never:

```text
ARCHIVED
DELETE
cursor reset
history delete
credential migration
```

Cursor/history remain intact for audit and manual rollback.

### Authority declaration

After all five CİTEM collectors are paused and all five Node sources are healthy:

```text
COLLECTION AUTHORITY: BAYKUSH INTELLIGENCE NODE
```

CİTEM Node API consumption is not part of NODE-2; it begins in NODE-4. During NODE-3 the legacy CİTEM global-source view may therefore stop receiving fresh legacy collector data while Node remains the collection authority.

## Rollback

Rollback is operator-controlled and source-specific. Automatic dual-authority failback is prohibited.

Required order:

```text
1. Operator declares rollback for one source.
2. Disable that source on Node.
3. Drain/resolve any active Node work for that source.
4. Resume the preserved CİTEM source connection.
5. Keep the preserved legacy cursor/history.
6. Confirm the first CİTEM collection succeeds.
7. Record the authority transition.
```

Never enable Node and CİTEM as simultaneous collection authorities for the same source as an automatic fallback strategy.

## Blocking conditions

Any of the following blocks NODE-2 closure:

- failed source work advances checkpoint;
- retry occurs before `available_at`;
- unrelated source work is blocked by one provider failure;
- normalization failure removes raw evidence;
- expired leases cannot be reclaimed;
- duplicate active run/raw/job/canonical identity exists;
- canonical or normalization provenance is orphaned/mismatched;
- provider secret is persisted in Node evidence/state;
- provider secret is injected into non-worker services;
- Node runtime contains private CİTEM workspace credentials/dependencies;
- live restart leaves scheduler/worker/normalizer without current heartbeat;
- production normalization queue has failed work at final audit;
- cutover destroys CİTEM cursor/history;
- rollback requires cursor reset;
- automatic dual-authority failback is enabled.

## Closure sequence

1. Automated NODE-2A–2G + resilience + audits green.
2. All five live parity results recorded.
3. Live scheduler/worker/normalizer restart gate passes.
4. Security/private-boundary audit passes with real worker credentials.
5. CİTEM cutover dry-run records cursor/history hashes and confirms zero active runs.
6. Five CİTEM source connections are paused.
7. Five Node sources remain healthy and normalization drains.
8. Cutover verification and rollback instructions are recorded.
9. `docs/NODE_2_ACCEPTANCE_REPORT.md` is finalized.
10. PR remains unmerged until explicit operator/user merge decision.

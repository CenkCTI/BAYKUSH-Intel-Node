# NODE-3 Operator Runbook

## Preconditions

- BAYKUSH Intelligence Node remains collection authority for CISA_KEV, NVD_CVE, FIRST_EPSS, THREATFOX and MALWAREBAZAAR.
- Legacy CİTEM collectors for those five sources remain paused.
- Do not reset or mutate CİTEM collection cursors as a NODE-3 troubleshooting step.
- Preserve local-only files that are not part of the Git branch.

## Apply migrations

Run the normal migration command from the NODE-3 branch:

```bash
npm run db:migrate
```

NODE-3 migrations are additive and continue the existing migration chain.

## Start the measurement runtime

Use the base compose file together with the NODE-3 overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.node3.yml up -d --build
```

The resulting stack includes PostgreSQL, API, scheduler, collector worker, normalizer and measurement runtime. Provider keys remain scoped to the collector worker; the measurement overlay contains no provider/CİTEM credentials.

## Status

```bash
npm run node3:status
```

For final acceptance expect:

- a recent `MEASUREMENT` heartbeat;
- projection queue eventually zero;
- coverage queue eventually zero;
- dirty measurement buckets eventually zero;
- dirty coverage buckets eventually zero;
- failed projection and coverage job counts zero.

## Registry

```bash
npm run node3:catalog
```

Registry synchronization fails closed if a previously published semantic/calculation version has a different hash.

## API smoke checks

Examples:

```bash
curl -s http://localhost:8080/v1/techint/measurement-catalog
```

```bash
curl -s 'http://localhost:8080/v1/techint/measurements?measurementKey=ioc.threatfox.reporting_volume&from=2026-08-12T00:00:00Z&to=2026-08-13T00:00:00Z&resolution=HOUR'
```

```bash
curl -s 'http://localhost:8080/v1/techint/coverage?sourceKey=THREATFOX&from=2026-08-12T00:00:00Z&to=2026-08-13T00:00:00Z'
```

```bash
curl -s 'http://localhost:8080/v1/techint/comparison?measurementKey=ioc.threatfox.reporting_volume&from=2026-08-12T12:00:00Z&to=2026-08-13T00:00:00Z'
```

A missing/unproven interval must be represented as `null`, not numeric zero.

## Rebuild from retained evidence

Measurement aggregate rebuild:

```bash
npx tsx src/cli/node3.ts measurement-rebuild \
  --measurement ioc.threatfox.reporting_volume \
  --from 2026-08-12T00:00:00Z \
  --to 2026-08-13T00:00:00Z
```

Coverage rebuild:

```bash
npx tsx src/cli/node3.ts coverage-rebuild \
  --source THREATFOX \
  --from 2026-08-12T00:00:00Z \
  --to 2026-08-13T00:00:00Z
```

These commands mark bounded projections dirty; they do not mutate immutable raw/canonical evidence.

## Historical backfill planning

Example plan only:

```bash
npx tsx src/cli/node3.ts backfill-plan \
  --source NVD_CVE \
  --from 2026-07-01T00:00:00Z \
  --to 2026-07-08T00:00:00Z
```

Persist an auditable request with `--persist true`.

A `PLANNED` request is not proof that historical acquisition occurred. NVD/EPSS provider execution deliberately remains collector-side and disabled until a separate backfill-owned checkpoint executor is accepted. Live `source_checkpoints` must not be rewound by historical work.

## Final audits

After measurement/coverage queues drain:

```bash
npm run node3:final-audit
```

Expected:

```json
{
  "schemaVersion": "NODE3_FINAL_AUDIT_V1",
  "accepted": true,
  "differences": []
}
```

Then:

```bash
npm run node3:security-audit
```

Expected `accepted: true`.

## Restart acceptance

Restart the combined stack and verify:

1. API/scheduler/worker/normalizer/measurement return to active heartbeats.
2. Existing leased work is safely reclaimable.
3. No duplicate active semantic measurement fact appears.
4. Unchanged inputs do not append duplicate aggregate revisions.
5. Queues drain again.
6. NODE-2G and NODE-3 audits remain accepted.
7. All five production source collectors remain healthy under Node authority.
8. Legacy CİTEM collectors remain paused.

## Merge rule

Do not merge PR #10 until CI is green and the real-stack acceptance above passes. A stale CİTEM view is not a reason to resume legacy collectors; any authority rollback must follow the existing NODE-2G rollback contract.

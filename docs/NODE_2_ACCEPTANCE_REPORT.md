# NODE-2 Final Acceptance Report

## Status

**Phase:** NODE-2 — Existing Production Sources  
**Closing phase:** NODE-2G — Five-Source Shadow Parity & Acceptance  
**Report state:** `COMPLETE`  
**Collection authority:** `BAYKUSH_INTELLIGENCE_NODE`

NODE-2 is accepted. The five admitted production TechINT sources have passed deterministic acceptance, live shadow parity, simultaneous live operation, restart/isolation testing, database invariant checks, credential/private-boundary checks, and the operator-controlled collection-authority cutover from legacy CİTEM collectors.

```text
NODE-2: COMPLETE
NODE-2G: ACCEPTED
COLLECTION AUTHORITY: BAYKUSH INTELLIGENCE NODE
NEXT PHASE: NODE-3 — Historical Activity, Coverage & Measurement Backbone
```

## Production source matrix

| Source | Semantics | Automated acceptance | Live parity | Post-cutover Node | Result |
|---|---|---:|---:|---:|---:|
| CISA KEV | `EXPLOITED_VULNERABILITY_CATALOG / PUBLISHED` | PASS | 1665/1665 exact | HEALTHY | PASS |
| NVD CVE | `VULNERABILITY_DATABASE / ENRICHED` | PASS | 66/66 bounded | HEALTHY | PASS |
| FIRST EPSS | `EXPLOIT_PROBABILITY / SCORED` | PASS | 2500/2500 exact | HEALTHY | PASS |
| ThreatFox | `IOC_SHARING / REPORTED` | PASS | guarded classified | HEALTHY | PASS |
| MalwareBazaar | `MALWARE_SAMPLE_REPOSITORY / PUBLISHED` | PASS | 7/7 bounded | HEALTHY | PASS |

Across the final accepted parity captures:

```text
REGRESSION             = 0
UNCLASSIFIED           = 0
blockingDifferences    = 0
unexplainedDifferences = 0
```

ThreatFox retains only evidence-backed migration classifications (`UNSUPPORTED_LEGACY`, `INTENTIONAL_DIFFERENCE`, monotonic `TEMPORAL_SKEW`). NVD retains the accepted source-specific observation-basis equivalence `ENRICHED` on Node versus `PUBLISHED` in legacy CİTEM; the compared NVD source facts themselves matched.

## Automated NODE-2G acceptance

The final deterministic package proves:

- [x] all five production adapters registered and admitted;
- [x] source definitions and source terms metadata complete;
- [x] successful PostgreSQL-backed collection and durable checkpoint per source;
- [x] immutable raw evidence and canonical evidence per source;
- [x] canonical -> raw and normalization -> raw provenance consistency;
- [x] no duplicate active scheduled/bootstrap run per source;
- [x] provenance manifests cannot become independent canonical intelligence;
- [x] NVD-mirrored CISA material cannot become independent CISA corroboration;
- [x] normalizers do not manufacture attack/victim/risk/priority/origin/target-country/global-threat-level facts;
- [x] parity projection coverage for CISA, NVD, EPSS, ThreatFox and MalwareBazaar;
- [x] `capturedAt` as-of raw-revision cutoff;
- [x] provider-failure isolation;
- [x] failed source work does not advance checkpoints;
- [x] exponential retry/backoff and terminal attempt ceiling;
- [x] normalization failure preserves raw evidence and prevents partial canonical evidence;
- [x] expired worker lease recovery;
- [x] expired normalizer lease recovery;
- [x] scheduler duplicate-run suppression;
- [x] final database invariant audit;
- [x] provider credentials scoped to the worker runtime;
- [x] private CİTEM/Supabase runtime credentials rejected from Node runtime;
- [x] TypeScript build and container build.

GitHub Actions evidence immediately preceding the operator cutover:

```text
Node head    = 7766368c0e81e801159694239c7d3c091267a3d8
workflow     = NODE validation
run          = #98
conclusion   = SUCCESS

CİTEM head   = a758559637577fd7919b33e388f411ce2c30d6c4
workflow     = Phase 2.1A validation
run          = #417
conclusion   = SUCCESS
```

## Live shadow parity evidence

### CISA KEV — PASS

```text
upstreamSnapshotId     = CISA:2026.08.11
nodeRecords            = 1665
citemRecords           = 1665
intersection           = 1665
nodeOnly               = 0
citemOnly               = 0
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
```

### FIRST EPSS — PASS

```text
upstreamSnapshotId     = EPSS:2026-08-12
nodeRecords            = 2500
citemRecords           = 2500
intersection           = 2500
nodeOnly               = 0
citemOnly               = 0
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
```

### ThreatFox — PASS

```text
nodeRecords             = 848
citemRecords            = 529
intersection            = 529
nodeOnly                = 319
citemOnly                = 0
blockingDifferences     = 0
unexplainedDifferences  = 0
accepted                = true

INTENTIONAL_DIFFERENCE  = 49
UNSUPPORTED_LEGACY      = 270
TEMPORAL_SKEW           = 11
```

The 270 unsupported legacy records are hash IOC reports outside the frozen legacy CİTEM mapper. The 49 intentional differences are explained by Node adaptive recovery versus the legacy provider-ID high-water behavior. The 11 intersecting differences were capture-order-consistent monotonic `lastSeen` advancement.

### MalwareBazaar — PASS

```text
windowStart            = 2026-08-12T21:08:55.148Z
windowEnd              = 2026-08-12T21:38:55.148Z
nodeRecords            = 7
citemRecords           = 7
intersection           = 7
nodeOnly               = 0
citemOnly               = 0
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
```

MalwareBazaar acceptance exposed and closed an as-of exporter defect. The Node parity projection now requires the selected raw revision to satisfy the explicit capture boundary before latest-revision selection. Runtime and operator parity-export interfaces expose optional `capturedAt`.

### NVD CVE — PASS

A pre-declared one-minute live NVD `lastModified` window was passed through the real legacy CİTEM adapter/mapper read-only, without moving the legacy production cursor.

```text
windowStart            = 2026-08-12T21:17:00.000Z
windowEnd              = 2026-08-12T21:18:00.000Z
recordsSeen            = 66
recordsMapped          = 66
mappingIssues          = 0
nodeRecords            = 66
citemRecords           = 66
intersection           = 66
nodeOnly               = 0
citemOnly               = 0
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
```

Accepted semantic equivalence:

```text
field          = observationBasis
Node           = ENRICHED
legacy CİTEM   = PUBLISHED
classification = SEMANTICALLY_EQUIVALENT
```

Critical NVD facts (`cve`, `published`, `lastModified`, `vulnStatus`) matched across all 66 records.

## Live restart / isolation gate — PASS

The real Docker stack was rebuilt with the final credential scope and the operator gate `scripts/node2g-live-restart-gate.sh` was executed against the live Node database.

Accepted live evidence:

- [x] baseline five-source state = `HEALTHY`;
- [x] baseline final database audit = accepted;
- [x] provider secrets absent from `api`, `scheduler` and `normalizer`;
- [x] private CİTEM runtime credentials absent from Node services;
- [x] scheduler restarted and produced a fresh heartbeat;
- [x] worker restarted and produced a fresh heartbeat;
- [x] normalizer restarted and produced a fresh heartbeat;
- [x] post-restart five-source state remained `HEALTHY`;
- [x] post-restart normalization queued/running/failed = `0/0/0`;
- [x] post-restart final database audit = accepted;
- [x] live credential-persistence/private-boundary audit = accepted.

Observed restart heartbeat ages during acceptance were within the gate threshold: Scheduler 9 seconds, Worker 5 seconds, Normalizer 2 seconds.

PostgreSQL/host failover, backup restore and Oracle host reboot remain NODE-8 rather than NODE-2.

## Final database invariant audit — PASS

The live final audit returned:

```text
schemaVersion                    = NODE2G_FINAL_AUDIT_V1
accepted                         = true
duplicateActiveRuns              = 0
duplicateRawRevisions            = 0
duplicateNormalizationJobs       = 0
duplicateCanonicalRecords        = 0
canonicalWithoutRaw              = 0
normalizationWithoutRaw          = 0
canonicalSourceMismatch          = 0
normalizationSourceMismatch      = 0
productionNormalizationQueued    = 0
productionNormalizationRunning   = 0
productionNormalizationFailed    = 0
badCheckpointLineage             = 0
```

## Security / private-boundary audit — PASS

The live worker audit returned:

```text
schemaVersion                  = NODE2G_SECURITY_AUDIT_V1
accepted                       = true
SUPABASE_SERVICE_ROLE_KEY      = absent from Node runtime
NEXT_PUBLIC_SUPABASE_URL       = absent from Node runtime
THREATFOX_AUTH_KEY persistence = 0 occurrences
MALWAREBAZAAR_AUTH_KEY         = 0 occurrences
NVD_API_KEY                    = NOT_CONFIGURED in accepted worker environment
```

Provider credentials are injected only into the worker service. No CİTEM private workspace credential was present in the Node runtime.

## CİTEM collection-authority cutover — PASS

The companion CİTEM operator tool performed a fail-closed dry-run before the authority change.

Dry-run evidence:

```text
runningRuns = 0
snapshot    = /tmp/citem-node2g-cutover-1786577538075.json
```

Pre-cutover source status was:

```text
CISA_KEV       = ENABLED
NVD_CVE        = PAUSED
FIRST_EPSS     = ENABLED
THREATFOX      = ENABLED
MALWAREBAZAAR  = ENABLED
```

The pre-existing NVD `PAUSED` state exposed a rollback-contract edge case. The CİTEM cutover tool was hardened so rollback restores the exact admitted pre-cutover state: a source that was `ENABLED` is restored to `ENABLED`; a source already `PAUSED` remains `PAUSED`. `ARCHIVED` is not silently restored and fails closed. A second active-run check after pause closes the scheduler claim race between preflight and status transition. The hardened CİTEM head passed validation run #417.

The real pause used an operator-private snapshot:

```text
snapshotPath             = /tmp/citem-node2g-pre-cutover.json
snapshot permissions     = 0600
runningRuns              = 0
cursorHistoryPreserved   = true
automaticFailback        = false
```

Post-pause state:

| Source | Status | Cursor SHA-256 | Preserved run history |
|---|---|---|---:|
| CISA KEV | PAUSED | `a7b531a8f6db3b65af01a1462e52d07fcc2f7fcce25176a8ab42d5971c0282df` | 13 |
| NVD CVE | PAUSED | `406f4de16ca6a0dbb0b23847b5987da2c1c712fea0ab93bc393fc44a6125d4a4` | 19 |
| FIRST EPSS | PAUSED | `28d8d7ad05dc5ebb4dddde1d0dfc9626803811f822d7a7280f3fc4d244869ab0` | 17 |
| ThreatFox | PAUSED | `3b46795f34e855fdf9d3705816363fcbedafe59da8162888a9e92099c1ffa232` | 12 |
| MalwareBazaar | PAUSED | `773d220f05ea26c5a744028c373da501aa8ee3eae9aaa200a0d06a3ffa2b1e35` | 14 |

No CİTEM source connection was archived or deleted, no cursor was reset, and no collection history was deleted.

## Post-cutover Node verification — PASS

After all five legacy CİTEM connections were paused, the Node remained authoritative and healthy:

```text
CISA_KEV       = HEALTHY, normalization 0/0/0
NVD_CVE        = HEALTHY, normalization 0/0/0
FIRST_EPSS     = HEALTHY, normalization 0/0/0
THREATFOX      = HEALTHY, normalization 0/0/0
MALWAREBAZAAR  = HEALTHY, normalization 0/0/0
final audit    = accepted
security audit = accepted
```

MalwareBazaar continued to advance under Node authority after cutover, reaching checkpoint revision 39 with a successful scheduled live-incremental run and no normalization failures.

## Rollback contract

Rollback remains manual and source-specific:

```text
1. disable the corresponding Node source
2. drain Node active work for that source
3. require NODE2G_ROLLBACK_CONFIRMED=true
4. verify current CİTEM cursor hash equals the preserved pre-cutover hash
5. restore the exact pre-cutover CİTEM status
6. verify the first resumed CİTEM run when the pre-cutover state was ENABLED
7. update the collection-authority record
```

Automatic Node -> CİTEM failback and simultaneous dual-authority collection are prohibited.

## Epistemic invariants retained

- Unknown != zero.
- No coverage != no activity.
- Reporting volume != attack volume.
- IOC volume != attack count.
- EPSS score != observed exploitation.
- MalwareBazaar sample volume != infection prevalence.
- NVD records != exploitation telemetry.
- CISA KEV membership != exploit-event count.
- Bootstrap ingestion != current activity.
- A mirror != an independent upstream origin.
- Source health != cyber activity.

## Known limitations after NODE-2

NODE-2 completion does not implement:

- historical 5m/hour/day measurement backbone;
- materialized coverage windows;
- trend/distribution/change APIs;
- cross-source convergence/corroboration;
- CİTEM Node API consumption / Global View;
- Internet telemetry;
- geography/map inference;
- additional providers;
- Oracle/host production hardening, backup or failover;
- ANLAK projection;
- AI analytic judgement.

These belong to later phases and do not block NODE-2 acceptance.

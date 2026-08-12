# NODE-2 Final Acceptance Report

## Status

**Phase:** NODE-2 — Existing Production Sources  
**Closing phase:** NODE-2G — Five-Source Shadow Parity & Acceptance  
**Report state:** `PENDING_LIVE_RESTART_AND_CUTOVER`  
**Collection authority cutover:** `NOT_YET_DECLARED`

All five production-source live shadow parity gates and every deterministic final-head CI gate are accepted. The remaining NODE-2 closure work is one live Docker scheduler/worker/normalizer restart gate, the live worker credential-persistence/private-boundary audit, and the operator-controlled CİTEM collection-authority pause/rollback verification.

## Production source matrix

| Source | Semantics | Automated source acceptance | Live Node | Live shadow parity | Result |
|---|---|---:|---:|---:|---:|
| CISA KEV | `EXPLOITED_VULNERABILITY_CATALOG / PUBLISHED` | PASS | PASS | PASS — 1665/1665 | PASS |
| NVD CVE | `VULNERABILITY_DATABASE / ENRICHED` | PASS | PASS | PASS — 66/66 bounded | PASS |
| FIRST EPSS | `EXPLOIT_PROBABILITY / SCORED` | PASS | PASS | PASS — 2500/2500 | PASS |
| ThreatFox | `IOC_SHARING / REPORTED` | PASS | PASS | PASS — guarded classified | PASS |
| MalwareBazaar | `MALWARE_SAMPLE_REPOSITORY / PUBLISHED` | PASS | PASS | PASS — 7/7 bounded | PASS |

Across the final accepted live parity captures:

```text
REGRESSION             = 0
UNCLASSIFIED           = 0
blockingDifferences    = 0
unexplainedDifferences = 0
```

ThreatFox retains only evidence-backed migration classifications (`UNSUPPORTED_LEGACY`, `INTENTIONAL_DIFFERENCE`, monotonic `TEMPORAL_SKEW`). NVD retains one accepted source-specific observation-basis equivalence (`ENRICHED` Node vs `PUBLISHED` legacy CİTEM) while the compared NVD source facts are exact.

## Automated NODE-2G gates

The aggregate suite runs after NODE-2A through NODE-2F against the same ephemeral PostgreSQL service.

Established:

- [x] all five production adapters registered;
- [x] source definitions synchronized;
- [x] source admission/terms metadata complete;
- [x] production sources disabled by default;
- [x] successful PostgreSQL-backed acceptance run and durable checkpoint per source;
- [x] immutable raw evidence and canonical evidence per source;
- [x] canonical -> raw and normalization -> raw provenance consistency;
- [x] no duplicate active scheduled/bootstrap run per source;
- [x] provenance manifests normalize to zero canonical intelligence;
- [x] NVD-mirrored CISA material does not become independent CISA corroboration;
- [x] normalizers do not manufacture attack/victim/risk/priority/origin/target-country/global-threat-level facts;
- [x] parity projection/unit coverage including bounded ThreatFox/MalwareBazaar/NVD behavior;
- [x] parity exporter `capturedAt` as-of revision cutoff covered by tests;
- [x] deterministic provider-failure isolation acceptance;
- [x] checkpoint non-advancement on failed source work;
- [x] exponential retry/backoff / hot-loop prevention acceptance;
- [x] normalization-failure raw-evidence preservation acceptance;
- [x] expired worker lease recovery acceptance;
- [x] expired normalizer lease recovery acceptance;
- [x] scheduler duplicate-run suppression acceptance;
- [x] final DB invariant audit;
- [x] provider credential worker-only compose scope audit;
- [x] Node private-CİTEM runtime dependency audit;
- [x] TypeScript build;
- [x] container build.

Final-head GitHub Actions evidence:

```text
head        = 8548cc20655b0c8753db113d1d76b9460dee1087
workflow    = NODE validation
run         = #95
conclusion  = SUCCESS
unit tests  = 112/112 PASS
NODE-2A..G  = PASS
resilience  = PASS
final audit = PASS
security    = PASS
build       = PASS
container   = PASS
```

Companion CİTEM PR #48 cutover-tool head `92008dcfa533b08ba775c6f98cefad07e4d3c76e` also completed Phase 2.1A validation successfully (run #413).

See `docs/NODE_2G_RESILIENCE_AND_CUTOVER.md`.

## Live shadow parity evidence

### CISA KEV — PASS

Accepted same upstream catalog:

```text
sourceKey              = CISA_KEV
upstreamSnapshotId     = CISA:2026.08.11
nodeRecords            = 1665
citemRecords           = 1665
intersection           = 1665
nodeOnly               = 0
citemOnly               = 0
sameUpstreamSnapshot   = true
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
```

The initial comparison exposed 19 presentation-only vendor/product differences caused by provider whitespace. The parity projection narrows equivalence only for those human-readable presentation fields; raw provider evidence remains unchanged.

### FIRST EPSS — PASS

Accepted score-date snapshot:

```text
sourceKey              = FIRST_EPSS
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

The acceptance process found and corrected the legacy CİTEM top-score selection defect. Historical pre-fix observations remain preserved; the acceptance projection reconstructs the current bounded population without deleting provenance.

### ThreatFox — PASS

Final guarded classified parity:

```text
sourceKey               = THREATFOX
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

Evidence:

- 270 Node-only hash IOC reports are outside the frozen legacy CİTEM ThreatFox mapper;
- 49 Node-only supported records are explained by Node adaptive recovery vs legacy provider-ID high-water behavior;
- all 11 intersecting differences were capture-order-consistent monotonic `lastSeen` advancement;
- no source identity, firstSeen, indicator value/type, malware-family or confidence regression remained.

### MalwareBazaar — PASS

Final frozen provider `first_seen` window:

```text
windowStart            = 2026-08-12T21:08:55.148Z
windowEnd              = 2026-08-12T21:38:55.148Z
upstreamSnapshotId     = null
nodeRecords            = 7
citemRecords           = 7
intersection           = 7
nodeOnly               = 0
citemOnly               = 0
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
differences            = []
```

Node was healthy with `recoveryGapExceeded=false` and zero queued/running/failed normalization work. CİTEM live collection succeeded after the server-side MalwareBazaar credential was corrected in the Vercel environment; no credential value entered parity artifacts.

#### Acceptance-tooling defect discovered and fixed

An earlier frozen comparison exposed a real exporter defect: Node selected the latest retained raw revision even when that revision had arrived after the intended frozen capture. The provider had advanced a MalwareBazaar signature after the capture, creating a false historical mismatch.

The Node projection now normalizes `capturedAt` and requires:

```text
received_at <= capturedAt
created_at  <= capturedAt
```

before choosing the latest raw revision per source identity. Unit coverage verifies the cutoff. Runtime and npm parity export interfaces now accept an optional explicit `capturedAt` so the fix is operationally usable, not only programmatic.

### NVD CVE — PASS

Legacy CİTEM could not complete the current multi-day catch-up because its frozen run ceiling rejected windows over 2,000 records. Existing Node and CİTEM databases also had non-overlapping historical `lastModified` coverage, so a DB-only historical comparison would have been invalid.

Acceptance therefore used one pre-declared one-minute live NVD `lastModified` window already present on Node and passed the same window through the real CİTEM NVD adapter/mapper read-only, without modifying the production CİTEM cursor.

Frozen window:

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

Comparator evidence retained one explicit source-semantic equivalence:

```text
field          = observationBasis
Node           = ENRICHED
legacy CİTEM   = PUBLISHED
classification = SEMANTICALLY_EQUIVALENT
```

Critical NVD facts (`cve`, `published`, `lastModified`, `vulnStatus`) matched across all 66 intersecting records.

## All-five live Node acceptance — PASS

All five production sources have been simultaneously enabled on the Node and observed `HEALTHY` with successful scheduled live-incremental runs and zero normalization failures. ThreatFox and MalwareBazaar recovery state remained within admitted recovery windows.

The final live restart gate will re-check these states after sequential scheduler/worker/normalizer restarts.

## Failure isolation / resilience — AUTOMATED PASS

Runtime design provides:

- scheduler suppression of a second active source run;
- idempotency key on scheduled/bootstrap run creation;
- worker/work-unit leases with expired-lease reclaim;
- normalizer leases with expired-lease reclaim;
- raw revision conflict identity `(source_definition_id, source_record_id, payload_sha256)`;
- normalization job identity `(raw_record_id, normalization_version)`;
- canonical identity `(raw_record_id, normalization_version, canonical_key, record_kind)`;
- raw/checkpoint/job/run successful persistence inside one transaction;
- exponential retry delay with configured maximum and provider Retry-After floor.

`test:node2g-resilience` now proves these invariants against PostgreSQL using `TEST_SYNTHETIC` plus process-local controlled source/normalizer failures. The test does not call live providers or alter production adapters. The final deterministic resilience gate passed in GitHub Actions run #95.

Operator live gate:

```text
scripts/node2g-live-restart-gate.sh
```

Pending live evidence:

- [ ] scheduler restart heartbeat and invariants accepted;
- [ ] worker restart heartbeat and invariants accepted;
- [ ] normalizer restart heartbeat and invariants accepted;
- [ ] post-restart five-source status accepted;
- [ ] post-restart final DB audit accepted.

PostgreSQL/host failover, backup restore and Oracle reboot remain NODE-8.

## Security / provenance — AUTOMATED PASS / LIVE SCAN PENDING

Established by source acceptance and final CI:

- [x] credentials remain server-side;
- [x] request URLs do not contain provider credentials;
- [x] raw/canonical/checkpoint/work descriptors do not persist credentials in authenticated-source acceptance;
- [x] controlled/redacted source failure diagnostics;
- [x] every canonical record traces to immutable raw evidence/source definition;
- [x] provider secrets removed from the shared Docker environment;
- [x] `NVD_API_KEY`, `THREATFOX_AUTH_KEY`, `MALWAREBAZAAR_AUTH_KEY` injected only into `worker`;
- [x] `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_URL` rejected from Node runtime environment;
- [x] CI static audit rejects private CİTEM/Supabase runtime dependencies in Node source/config;
- [x] runtime CLI exposes exact-secret persistence scan for configured worker credentials.

Pending live evidence with the real accepted worker environment:

- [ ] real worker credential persistence scan = zero occurrences;
- [ ] private CİTEM runtime credentials absent from Node containers.

## Collection-authority cutover

Companion CİTEM PR #48 contains a guarded operator tool and runbook for collection-authority cutover, and its current cutover-tool head passed validation.

Required final sequence:

- [ ] CİTEM dry-run resolves all five connections;
- [ ] zero active CİTEM `RUNNING` collections confirmed;
- [ ] local mode-0600 pre-cutover snapshot written outside Git;
- [ ] cursor version/SHA and run-history counts recorded;
- [ ] CISA KEV connection paused;
- [ ] NVD CVE connection paused;
- [ ] FIRST EPSS connection paused;
- [ ] ThreatFox connection paused;
- [ ] MalwareBazaar connection paused;
- [ ] every cursor hash unchanged after pause;
- [ ] every legacy run-history count unchanged after pause;
- [ ] Node five-source health/final audit re-confirmed;
- [ ] manual rollback procedure accepted;
- [ ] no automatic dual-authority failback enabled.

Cutover means `ENABLED -> PAUSED`, never archive/delete/reset. Legacy CİTEM cursor/history and credentials remain preserved. CİTEM Node API consumption begins in NODE-4, not NODE-2.

Rollback order is source-specific and manual:

```text
Node source disable -> Node active work drain -> CİTEM source resume -> first CİTEM run verify -> authority record update
```

Automatic failback from Node to CİTEM is prohibited.

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

## Closure declaration

Do not apply this declaration until the remaining live restart/security/cutover checkboxes are accepted:

```text
NODE-2: COMPLETE
NODE-2G: ACCEPTED
COLLECTION AUTHORITY: BAYKUSH INTELLIGENCE NODE
NEXT PHASE: NODE-3 — Historical Activity, Coverage & Measurement Backbone
```

# NODE-2 Final Acceptance Report

## Status

**Phase:** NODE-2 — Existing Production Sources  
**Closing phase:** NODE-2G — Five-Source Shadow Parity & Acceptance  
**Report state:** `PENDING_SHADOW_PARITY_AND_CUTOVER`  
**Collection authority cutover:** `NOT_YET_DECLARED`

This document becomes the authoritative NODE-2 closure record after automated CI, live shadow parity, all-five live acceptance and operator-controlled legacy CİTEM collector cutover are complete.

## Production source matrix

| Source | Adapter | Source semantics | Individual automated acceptance | Individual live acceptance | Shadow parity | NODE-2G result |
|---|---|---|---|---|---|---|
| CISA KEV | implemented | `EXPLOITED_VULNERABILITY_CATALOG / PUBLISHED` | PASS | PASS | LIVE PASS; COMMON PENDING | PENDING |
| NVD CVE | implemented | `VULNERABILITY_DATABASE / ENRICHED` | PASS | PASS | PENDING | PENDING |
| FIRST EPSS | implemented | `EXPLOIT_PROBABILITY / SCORED` | PASS | PASS | LIVE PASS; COMMON PENDING | PENDING |
| ThreatFox | implemented | `IOC_SHARING / REPORTED` | PASS | PASS | LIVE PASS; COMMON PASS | PASS |
| MalwareBazaar | implemented | `MALWARE_SAMPLE_REPOSITORY / PUBLISHED` | PASS | PASS | AUTOMATED PREP IMPLEMENTED; LIVE PENDING | PENDING |

## Automated NODE-2G gates

The aggregate NODE-2G suite runs after NODE-2A through NODE-2F against the same PostgreSQL service.

- [x] all five production adapters registered;
- [x] all source definitions synchronized;
- [x] source admission/terms metadata complete;
- [x] production sources remain disabled by default;
- [x] each source has at least one successful PostgreSQL-backed acceptance run;
- [x] each source has a durable checkpoint;
- [x] each source has immutable raw evidence;
- [x] each source has canonical evidence;
- [x] mixed normalization queue drains to zero queued/running/failed;
- [x] every canonical record retains raw provenance;
- [x] no canonical/raw source identity mismatch;
- [x] no normalization/raw source identity mismatch;
- [x] no duplicate active scheduled/bootstrap run per source;
- [x] CISA/EPSS/ThreatFox/MalwareBazaar provenance manifests normalize to zero canonical intelligence records;
- [x] NVD-mirrored CISA fields do not become independent CISA corroboration;
- [x] source normalization manufactures no attack-count, victim-count, business-risk, remediation-priority, attacker-origin, target-country or global-threat-level facts;
- [x] lint/typecheck/unit tests/migrations/NODE-1/NODE-2A–2G/build/container build pass on the accepted pre-MalwareBazaar-prep head;
- [ ] latest MalwareBazaar parity-hardening head and companion CİTEM PR validation both green.

## Shadow parity gates

### Common-payload parity

- [ ] CISA KEV — zero regressions;
- [x] NVD CVE — deterministic critical-fact common-payload projection covered;
- [ ] FIRST EPSS — zero regressions;
- [x] ThreatFox — deterministic shared-provider critical-fact projection covered on both sides;
- [ ] MalwareBazaar — implementation added on both sides; awaiting final companion CI confirmation.

### Live shadow parity

Every unmatched record must be classified under `docs/NODE_2_DIFFERENCE_REGISTER.md` or explicit parity evidence.

- [x] CISA KEV accepted;
- [ ] NVD CVE accepted;
- [x] FIRST EPSS accepted;
- [x] ThreatFox accepted;
- [ ] MalwareBazaar accepted;
- [ ] unexplained critical mismatches = 0 across all five sources;
- [ ] unclassified differences = 0 across all five sources.

### CISA KEV live parity evidence

Operator run on 2026-08-12 after legacy CİTEM CISA KEV was synchronized to catalog `2026.08.11` and Node was already on the same upstream catalog:

```text
sourceKey             = CISA_KEV
upstreamSnapshotId    = CISA:2026.08.11
nodeRecords           = 1665
citemRecords          = 1665
intersection          = 1665
nodeOnly              = 0
citemOnly             = 0
sameUpstreamSnapshot  = true
blockingDifferences   = 0
unexplainedDifferences= 0
accepted              = true
```

The first comparison exposed 19 presentation-only `vendor`/`product` differences caused exclusively by leading/trailing or Unicode whitespace in the provider strings. No source identity or semantic fact was lost. NODE-2G was narrowed so only CISA human-readable `vendor`/`product` parity comparison treats Unicode presentation whitespace as equivalent; raw provider evidence remains unchanged and CVE/date/ransomware fields remain strict.

**CISA KEV live shadow parity: PASS.**

### FIRST EPSS live parity evidence

Operator acceptance on 2026-08-12 used the same score-date snapshot identity `EPSS:2026-08-12` on Node and CİTEM.

Initial parity exposed a real legacy selection defect rather than a mapper mismatch: both sides emitted 2,500 records but intersected on only 552 CVEs. Node's selected population had minimum EPSS about `0.69564`; legacy CİTEM extended down to about `0.1002`, while the highest-scoring records matched. The CİTEM REST request was corrected to use the EPSS endpoint's top-score ordering contract.

The corrected CİTEM collection then processed 2,500 rows and durably created exactly 1,948 previously absent signals, matching the earlier membership delta. A transient experimental cursor-field change caused that first corrected run to fail only at final cursor completion; the cursor extension was removed without a database migration. The subsequent manual CİTEM FIRST EPSS run completed:

```text
status          = SUCCEEDED
trigger         = MANUAL
records mapped  = 2500
signals created = 0
error           = none
```

Because CİTEM Technical Signal observations are append-only, the superseded pre-fix same-date members remain preserved as historical provenance. NODE-2G does not delete those observations. Instead, the CİTEM acceptance projection reconstructs the current bounded population deterministically by EPSS descending, percentile descending, CVE ascending, then selects the first 2,500. This projection-only behavior is documented as `D-EPSS-004`.

Final canonical parity:

```text
sourceKey              = FIRST_EPSS
upstreamSnapshotId     = EPSS:2026-08-12
nodeRecords            = 2500
citemRecords           = 2500
intersection           = 2500
nodeOnly               = 0
citemOnly              = 0
sameUpstreamSnapshot   = true
blockingDifferences    = 0
unexplainedDifferences = 0
accepted               = true
differences            = []
```

**FIRST EPSS live shadow parity: PASS.**

### ThreatFox live parity evidence

Operator acceptance on 2026-08-12 used `upstreamSnapshotId = null` and identical explicit provider `first_seen` boundaries on the Node and CİTEM parity exports.

Final classified parity:

```text
sourceKey               = THREATFOX
nodeRecords             = 848
citemRecords            = 529
intersection            = 529
nodeOnly                = 319
citemOnly               = 0
blockingDifferences     = 0
unexplainedDifferences  = 0
accepted                = true

INTENTIONAL_DIFFERENCE  = 49
UNSUPPORTED_LEGACY      = 270
TEMPORAL_SKEW           = 11
```

Evidence classification:

- 270 Node-only records were provider hash IOC types (`sha256_hash`, `sha1_hash`, `md5_hash`) preserved by Node but outside the frozen legacy CİTEM ThreatFox TechINT mapper. These are `UNSUPPORTED_LEGACY`.
- 49 Node-only records were supported `domain`, `ip:port` or `url` reports whose provider IDs were already behind the legacy CİTEM provider-ID high-water while Node adaptive recovery retained them. These are `INTENTIONAL_DIFFERENCE` under the frozen recovery-model difference.
- all 11 intersecting critical-fact mismatches were `lastSeen`; every value advanced monotonically on the later capture. The comparator now classifies only capture-order-consistent monotonic `lastSeen` evolution as `TEMPORAL_SKEW`; backwards movement remains a regression.

No source identity, `firstSeen`, indicator value/type, malware-family label or provider-confidence regression remained.

**ThreatFox live shadow parity: PASS.**

### MalwareBazaar parity preparation

The source-specific acceptance contract is frozen in `docs/NODE_2G_MALWAREBAZAAR_PARITY.md` before the live comparison.

Implemented preparation:

- parity identity = lowercase provider SHA-256;
- live `upstreamSnapshotId = null`;
- Node exporter requires explicit provider `first_seen` boundaries and filters `raw_source_records.effective_at`;
- companion CİTEM exporter requires the same explicit boundaries and filters `technical_signal_observations.source_published_at`;
- the comparator rejects missing/unbounded/mismatched MalwareBazaar scopes as `REGRESSION`;
- deterministic Node/CİTEM fixture coverage freezes SHA-256, SHA-1, MD5, `firstSeen`, `lastSeen`, file name/size/type/MIME, signature, reporter and tags;
- tags compare order-insensitively;
- moving-source `lastSeen` may be `TEMPORAL_SKEW` only when capture ordering supports monotonic source evolution, including null-to-datetime advancement;
- a later capture moving `lastSeen` backwards remains `REGRESSION`;
- Node raw query manifests remain excluded from parity membership;
- no cursor reset, history deletion, selector rewrite, credential migration or malware binary download was introduced.

Live acceptance remains pending. Count equality is not an acceptance requirement because Node uses the admitted recent-time model while frozen legacy CİTEM uses `selector=100` plus `lastFirstSeen` high-water.

## All-five live Node acceptance

**Operator observation:** 2026-08-12 15:52 CEST / 13:52 UTC. All five production sources were simultaneously enabled on the NODE-2G branch and allowed to complete their scheduled live-incremental work.

| Source | Latest run | Health | Checkpoint | Normalization failed | Coverage/recovery note |
|---|---|---|---|---|---|
| CISA KEV | `SUCCEEDED / SCHEDULED / LIVE_INCREMENTAL` at 13:48:42Z | `HEALTHY` | revision 2; catalog `2026.08.11`, 1665 entries | 0 | official GitHub mirror retrieval; current snapshot complete |
| NVD CVE | `SUCCEEDED / SCHEDULED / LIVE_INCREMENTAL` at 13:49:09Z | `HEALTHY` | revision 4; completedThrough `2026-08-12T13:48:46.712Z` | 0 | historical-query watermark advanced successfully |
| FIRST EPSS | `SUCCEEDED / SCHEDULED / LIVE_INCREMENTAL` at 13:49:12Z | `HEALTHY` | revision 3; dataset date `2026-08-12`, model `v2026.06.15` | 0 | current daily dataset collected successfully |
| ThreatFox | `SUCCEEDED / SCHEDULED / LIVE_INCREMENTAL` at 13:49:13Z | `HEALTHY` | revision 2; 1-day recovery window, 780 records | 0 | `recoveryGapExceeded=false` |
| MalwareBazaar | `SUCCEEDED / SCHEDULED / LIVE_INCREMENTAL` at 13:49:14Z | `HEALTHY` | revision 2; 60-minute window, 14 records | 0 | `recoveryGapExceeded=false` |

Observed aggregate result across every per-source status:

```text
normalization queued  = 0
normalization running = 0
normalization failed  = 0
```

**All-five live Node acceptance: PASS.**

A source may be operationally `HEALTHY` while retaining a historical recovery gap. Current health must not overwrite coverage-gap state.

## Failure isolation evidence

- [ ] one controlled provider failure does not stop unrelated sources;
- [ ] failed source work does not advance that source checkpoint;
- [ ] retry/backoff does not create a hot loop;
- [ ] normalization failure preserves raw evidence;
- [ ] scheduler/worker/normalizer process restart does not create duplicate canonical evidence or duplicate active scheduled runs.

Long-running host/DB failover soak, backup restore and Oracle reboot acceptance remain NODE-8.

## Security/provenance evidence

- [x] provider credentials remain server-side in automated source acceptance;
- [x] credentials absent from source request URLs in automated acceptance;
- [x] credentials absent from persisted raw evidence in authenticated-source acceptance;
- [x] credentials absent from canonical evidence in authenticated-source acceptance;
- [x] credentials absent from authenticated-source checkpoints/work descriptors/manifests in automated acceptance;
- [x] persisted source failures use controlled/redacted diagnostics in source acceptance suites;
- [x] every canonical record traces to immutable raw evidence and source definition in NODE-2G aggregate acceptance;
- [ ] no private CİTEM workspace data is sent to Node — to be confirmed during collection-authority cutover/integration boundary review.

## Collection-authority cutover

After all gates above pass:

- [ ] BAYKUSH Intelligence Node declared collection authority for the five production public/global sources;
- [ ] legacy CİTEM CISA KEV collector paused;
- [ ] legacy CİTEM NVD collector paused;
- [ ] legacy CİTEM FIRST EPSS collector paused;
- [ ] legacy CİTEM ThreatFox collector paused;
- [ ] legacy CİTEM MalwareBazaar collector paused;
- [ ] legacy CİTEM source history preserved;
- [ ] legacy CİTEM source cursors preserved;
- [ ] legacy CİTEM credentials/history not destructively migrated;
- [ ] manual rollback procedure verified/documented;
- [ ] no automatic dual-authority fallback enabled.

CİTEM Node API consumption is **not** part of NODE-2G; it begins in NODE-4.

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

NODE-2 completion does not mean the full BAYKUSH Intelligence Node is complete. The following remain intentionally unimplemented:

- Node historical 5m/hour/day measurement backbone;
- materialized Node coverage windows;
- trend/distribution/change APIs;
- cross-source convergence/corroboration logic;
- CİTEM Node API consumption and Global View cutover;
- Internet telemetry;
- geography/map inference;
- new source packs;
- Oracle production hardening/backups/observability;
- ANLAK projection;
- AI analytic judgement.

## Closure declaration

When every required box is complete, replace the report state with:

```text
NODE-2: COMPLETE
NODE-2G: ACCEPTED
COLLECTION AUTHORITY: BAYKUSH INTELLIGENCE NODE
NEXT PHASE: NODE-3 — Historical Activity, Coverage & Measurement Backbone
```

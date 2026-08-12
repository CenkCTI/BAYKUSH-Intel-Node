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
| CISA KEV | implemented | `EXPLOITED_VULNERABILITY_CATALOG / PUBLISHED` | PASS | PASS | PENDING | PENDING |
| NVD CVE | implemented | `VULNERABILITY_DATABASE / ENRICHED` | PASS | PASS | PENDING | PENDING |
| FIRST EPSS | implemented | `EXPLOIT_PROBABILITY / SCORED` | PASS | PASS | PENDING | PENDING |
| ThreatFox | implemented | `IOC_SHARING / REPORTED` | PASS | PASS | PENDING | PENDING |
| MalwareBazaar | implemented | `MALWARE_SAMPLE_REPOSITORY / PUBLISHED` | PASS | PASS | PENDING | PENDING |

## Automated NODE-2G gates

GitHub Actions `NODE validation` run #45 on head `990c501f8c7b92d081e12ae78e0c108c0d5fd400` completed successfully on 2026-08-12. `test:node2g` ran after NODE-2A through NODE-2F against the same PostgreSQL service.

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
- [x] lint/typecheck/unit tests/migrations/NODE-1/NODE-2A–2G/build/container build all pass.

## Shadow parity gates

### Common-payload parity

- [ ] CISA KEV — zero regressions;
- [ ] NVD CVE — zero regressions;
- [ ] FIRST EPSS — zero regressions;
- [ ] ThreatFox — zero regressions/unclassified differences;
- [ ] MalwareBazaar — zero regressions/unclassified differences.

### Live shadow parity

Every unmatched record must be classified under `docs/NODE_2_DIFFERENCE_REGISTER.md` or explicit parity evidence.

- [ ] CISA KEV accepted;
- [ ] NVD CVE accepted;
- [ ] FIRST EPSS accepted;
- [ ] ThreatFox accepted;
- [ ] MalwareBazaar accepted;
- [ ] unexplained critical mismatches = 0;
- [ ] unclassified differences = 0.

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

A source may be operationally `HEALTHY` while retaining a historical recovery gap. Current health must not overwrite coverage-gap state. Both bounded sources reported no recovery gap in this acceptance capture.

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

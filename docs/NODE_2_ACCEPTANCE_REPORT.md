# NODE-2 Final Acceptance Report

## Status

**Phase:** NODE-2 — Existing Production Sources  
**Closing phase:** NODE-2G — Five-Source Shadow Parity & Acceptance  
**Report state:** `PENDING_OPERATOR_ACCEPTANCE`  
**Collection authority cutover:** `NOT_YET_DECLARED`

This document becomes the authoritative NODE-2 closure record after automated CI, live shadow parity, all-five live acceptance and operator-controlled legacy CİTEM collector cutover are complete.

## Production source matrix

| Source | Adapter | Source semantics | Individual automated acceptance | Individual live acceptance | Shadow parity | NODE-2G result |
|---|---|---|---|---|---|---|
| CISA KEV | implemented | `EXPLOITED_VULNERABILITY_CATALOG / PUBLISHED` | PASS before NODE-2G | PASS before NODE-2G | PENDING | PENDING |
| NVD CVE | implemented | `VULNERABILITY_DATABASE / ENRICHED` | PASS before NODE-2G | PASS before NODE-2G | PENDING | PENDING |
| FIRST EPSS | implemented | `EXPLOIT_PROBABILITY / SCORED` | PASS before NODE-2G | PASS before NODE-2G | PENDING | PENDING |
| ThreatFox | implemented | `IOC_SHARING / REPORTED` | PASS before NODE-2G | PASS before NODE-2G | PENDING | PENDING |
| MalwareBazaar | implemented | `MALWARE_SAMPLE_REPOSITORY / PUBLISHED` | PASS before NODE-2G | PASS before NODE-2G | PENDING | PENDING |

## Automated NODE-2G gates

To be completed from GitHub Actions and `npm run test:node2g` evidence.

- [ ] all five production adapters registered;
- [ ] all source definitions synchronized;
- [ ] source admission/terms metadata complete;
- [ ] production sources remain disabled by default;
- [ ] each source has at least one successful PostgreSQL-backed acceptance run;
- [ ] each source has a durable checkpoint;
- [ ] each source has immutable raw evidence;
- [ ] each source has canonical evidence;
- [ ] mixed normalization queue drains to zero queued/running/failed;
- [ ] every canonical record retains raw provenance;
- [ ] no canonical/raw source identity mismatch;
- [ ] no normalization/raw source identity mismatch;
- [ ] no duplicate active scheduled/bootstrap run per source;
- [ ] CISA/EPSS/ThreatFox/MalwareBazaar provenance manifests normalize to zero canonical intelligence records;
- [ ] NVD-mirrored CISA fields do not become independent CISA corroboration;
- [ ] source normalization manufactures no attack-count, victim-count, business-risk, remediation-priority, attacker-origin, target-country or global-threat-level facts;
- [ ] lint/typecheck/unit tests/migrations/NODE-1/NODE-2A–2G/build/container build all pass.

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

Record the operator-observed source status after all five sources have been enabled in the bounded acceptance environment.

| Source | Latest run | Health | Checkpoint | Normalization failed | Coverage/recovery note |
|---|---|---|---|---|---|
| CISA KEV | PENDING | PENDING | PENDING | PENDING | PENDING |
| NVD CVE | PENDING | PENDING | PENDING | PENDING | PENDING |
| FIRST EPSS | PENDING | PENDING | PENDING | PENDING | PENDING |
| ThreatFox | PENDING | PENDING | PENDING | PENDING | PENDING |
| MalwareBazaar | PENDING | PENDING | PENDING | PENDING | PENDING |

Required aggregate result:

```text
normalization queued  = 0
normalization running = 0
normalization failed  = 0
```

A source may be operationally `HEALTHY` while retaining a historical recovery gap. Current health must not overwrite coverage-gap state.

## Failure isolation evidence

- [ ] one controlled provider failure does not stop unrelated sources;
- [ ] failed source work does not advance that source checkpoint;
- [ ] retry/backoff does not create a hot loop;
- [ ] normalization failure preserves raw evidence;
- [ ] scheduler/worker/normalizer process restart does not create duplicate canonical evidence or duplicate active scheduled runs.

Long-running host/DB failover soak, backup restore and Oracle reboot acceptance remain NODE-8.

## Security/provenance evidence

- [ ] provider credentials remain server-side;
- [ ] credentials absent from URLs;
- [ ] credentials absent from raw evidence;
- [ ] credentials absent from canonical evidence;
- [ ] credentials absent from checkpoints/work descriptors/manifests;
- [ ] credentials absent from persisted safe failure diagnostics;
- [ ] every canonical record traces to immutable raw evidence and source definition;
- [ ] no private CİTEM workspace data is sent to Node.

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

# NODE-2G — Five-Source Shadow Parity and NODE-2 Acceptance

## Goal

NODE-2G closes NODE-2. It does not add a sixth source, historical measurements, Global View APIs, cross-source convergence, risk scoring, geography, AI analysis, or CİTEM Node consumption.

The phase proves that the five admitted production TechINT sources can coexist on one BAYKUSH Intelligence Node while preserving collection isolation, immutable raw truth, canonical provenance, source semantics, credential boundaries, restart-safe state, and explainable migration differences from the legacy CİTEM collectors.

Production source pack:

- `CISA_KEV`
- `NVD_CVE`
- `FIRST_EPSS`
- `THREATFOX`
- `MALWAREBAZAAR`

## Core migration principle

Parity does **not** mean that the Node reproduces CİTEM database rows, signal types, counts, cursors, or mapper implementation byte-for-byte.

Parity means that the Node preserves the same upstream source truth and epistemic boundary, while every deliberate architectural difference is classified and documented.

A difference may be:

- `SEMANTICALLY_EQUIVALENT`
- `NODE_SUPERSET`
- `INTENTIONAL_DIFFERENCE`
- `TEMPORAL_SKEW`
- `UNSUPPORTED_LEGACY`
- `REGRESSION`
- `UNCLASSIFIED`

`REGRESSION` and `UNCLASSIFIED` block cutover. Intentional differences do not.

## Two-layer parity

### 1. Common-payload parity

The same provider snapshot is projected through the Node and CİTEM mappings. The neutral `NODE2G_PARITY_V1` contract compares provider identity, critical source facts and source semantics rather than internal database schemas.

This removes provider-time skew from mapper validation.

### 2. Live shadow parity

The legacy CİTEM collector and BAYKUSH Node collect in a bounded shadow window. Live membership differences are reviewed and classified. ThreatFox and MalwareBazaar do not require raw count equality because the legacy and Node retrieval windows intentionally differ.

## Neutral parity contract

The Node exports a source-neutral snapshot with:

- producer (`NODE` or `CITEM`);
- source key;
- capture time;
- optional exact upstream-snapshot identity;
- optional source window;
- source class and observation basis;
- source-record identity;
- subject;
- source times;
- a bounded set of critical source facts.

The contract intentionally excludes Node canonical IDs, CİTEM Technical Signal IDs, database UUIDs, internal cursors, risk scores, anomaly outputs and derived analyst state.

Node export:

```bash
npm run node2g:export-node -- CISA_KEV > artifacts/node2g/cisa-node.json
```

For common-payload acceptance an operator may supply the same explicit upstream snapshot ID to both exporters:

```bash
npm run node2g:export-node -- CISA_KEV cisa-release-2026-08-12 > artifacts/node2g/cisa-node.json
```

Compare against a CİTEM exporter that implements `NODE2G_PARITY_V1`:

```bash
npm run node2g:parity -- artifacts/node2g/cisa-node.json artifacts/node2g/cisa-citem.json
```

Live unmatched records must be explicitly classified before acceptance. Optional classifications are supplied as a JSON array:

```json
[
  {
    "side": "NODE_ONLY",
    "sourceRecordId": "123456",
    "classification": "TEMPORAL_SKEW",
    "reason": "The Node request completed after the CİTEM shadow capture."
  }
]
```

## Source-specific parity rules

### CISA KEV

Critical facts:

- CVE identity;
- `dateAdded`;
- `dueDate`;
- vendor;
- product;
- ransomware-use source value.

For the same upstream catalog snapshot, membership must match exactly. Node catalog-level metadata is separated from entry revision identity so a new catalog release does not manufacture revisions for unchanged CVEs. The official GitHub mirror and CISA feed share one upstream origin and are never treated as independent corroboration.

### NVD CVE

Critical facts:

- CVE identity;
- published timestamp;
- last-modified timestamp;
- vulnerability status.

For the same last-modified window, membership must match exactly. The Node preserves the complete NVD metrics container and complete raw CPE applicability logic. NVD-mirrored CISA fields are not promoted into independent CISA corroboration.

### FIRST EPSS

Critical facts:

- CVE identity;
- EPSS score;
- percentile;
- score date.

Same-date common-payload parity requires exact bounded-capture membership and exact source score values. The Node's official daily artifact provenance, model version and dataset hashes are a deliberate superset of the legacy CİTEM REST projection.

### ThreatFox

Critical facts for intersecting provider IDs:

- provider ID;
- IOC type;
- IOC value;
- first seen;
- last seen;
- malware-family label;
- provider confidence.

Live count equality is not required. Node-only/CİTEM-only records must be classified as timing, lookback/high-water behavior, unsupported legacy mapping, deliberate Node preservation, or regression. Unknown/new IOC types remain source reports instead of disappearing.

### MalwareBazaar

Critical facts for intersecting SHA-256 identities:

- SHA-256/SHA-1/MD5;
- first/last seen;
- file name/size/type/MIME;
- source signature;
- reporter;
- tags.

Live count equality is explicitly invalid because legacy CİTEM uses `selector=100` while Node uses the rolling `selector=time` additions window. Additional raw MalwareBazaar metadata is a Node superset. Malware binaries remain out of scope.

## Automated aggregate acceptance

CI runs NODE-1 and NODE-2A through NODE-2F first. NODE-2G then audits their shared PostgreSQL state and requires:

- all five production adapters registered;
- synchronized source definitions;
- frozen source class/observation basis contracts;
- complete admission metadata and terms references;
- disabled-by-default production sources;
- at least one successful PostgreSQL-backed collection run per source;
- durable checkpoints for all five sources;
- raw evidence for every source;
- canonical evidence for every source;
- zero queued/running/failed normalization work after drain;
- canonical-to-raw source/provenance consistency;
- normalization-to-raw source consistency;
- zero canonical evidence without raw provenance;
- zero duplicate active scheduled/bootstrap runs per source;
- raw-only catalog/query/dataset manifests normalize successfully to zero canonical intelligence records;
- NVD does not manufacture independent CISA corroboration;
- source normalizers do not manufacture attack-count, victim-count, business-risk, attacker-origin, target-country, remediation-priority or global-threat-level facts.

Run locally after NODE-2A–2F acceptance state exists:

```bash
npm run test:node2g
npm run node2g:status
npm run node2g:report
```

## Live all-five acceptance

The manual live gate is deliberately bounded. It does not require a 24-hour soak; long-running infrastructure soak belongs to NODE-8.

1. Configure operator-side provider credentials without exposing them in logs or shell history.
2. Enable all five production sources.
3. Confirm each source obtains at least one successful run.
4. Confirm each source retains its own checkpoint and source health.
5. Drain normalization to `queued=0`, `running=0`, `failed=0`.
6. Confirm one provider failure does not stop unrelated source collection.
7. Confirm a failed work unit cannot advance that source's checkpoint.
8. Confirm provider credentials are absent from persisted raw/canonical/checkpoint/work/failure state.
9. Disable sources again if this is a development acceptance environment.

A current `HEALTHY` source state is not equivalent to complete historical coverage. ThreatFox and MalwareBazaar recovery-gap state must survive later successful requests.

## Collection-authority cutover

NODE-2G does not delete CİTEM collectors, tables, historical observations, credentials or cursors.

After five-source shadow parity is accepted:

- BAYKUSH Intelligence Node becomes the collection authority for these five public/global sources;
- the legacy CİTEM five-source collection path is intentionally paused through operator-controlled CİTEM configuration;
- historical CİTEM data and cursors remain preserved for rollback/audit;
- private CİTEM workspace data is never copied to Node;
- CİTEM does not yet consume Node data in this phase; Node API consumption begins in NODE-4.

Automatic failback is prohibited. If a critical Node source failure requires temporary legacy collection, an operator explicitly disables the affected Node source, re-enables the preserved CİTEM collector and records the operational exception.

## Cutover invariant

Do not run the legacy CİTEM collector and Node API consumption as two authoritative production streams for the same provider. That would create double-counting and ambiguous provenance.

## Restart and isolation boundary

NODE-2G keeps the existing NODE-1/NODE-2A durable runtime contract:

- scheduler restart must not create duplicate active scheduled runs;
- worker restart resumes from durable work/checkpoint state;
- normalizer restart preserves completed canonical evidence and continues queued work without duplicate canonical rows;
- provider failure remains source-local operational state;
- normalization failure never deletes or rewrites raw source truth.

PostgreSQL failover, backups, restore drills, host reboot soak and Oracle production operations remain NODE-8.

## Epistemic invariants

- Unknown != zero.
- No coverage != no activity.
- Reporting volume != attack volume.
- IOC volume != attack count.
- EPSS score != observed exploitation.
- MalwareBazaar sample volume != infection prevalence.
- NVD records != exploitation telemetry.
- CISA KEV membership != exploit-event count.
- Bootstrap ingestion != current technical activity.
- A mirror != an independent upstream origin.
- Source health != cyber activity.

## Exit criteria

NODE-2 is complete only when:

1. NODE-2G CI is green;
2. automated five-source readiness is green;
3. all five individual live source admissions remain accepted;
4. common-payload parity contains no regressions;
5. live shadow parity contains no regressions or unclassified differences;
6. all-five live collection/normalization acceptance passes;
7. `docs/NODE_2_DIFFERENCE_REGISTER.md` contains every intentional migration difference;
8. `docs/NODE_2_ACCEPTANCE_REPORT.md` records the final operator evidence;
9. the legacy CİTEM five-source collection authority is intentionally paused and rollback is documented.

Only after these gates should NODE-2G be marked merge-ready and NODE-2 declared complete.

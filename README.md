# BAYKUSH Intelligence Node

Shared intelligence data collection, preservation, normalization, history, and measurement infrastructure for the BAYKUSH ecosystem.

## Mission

The Node continuously collects approved public/global intelligence sources so BAYKUSH modules do not need to independently poll and normalize the same upstream data.

Core operating principle:

> Collect once. Preserve source truth. Normalize once. Project many times.

The Node is intended to feed:

- **CİTEM** — technical cyber intelligence / TechINT projection;
- **ANLAK** — future OSINT / strategic-intelligence projection.

The first deployment target is an Oracle VM, but the runtime is designed to remain provider-independent.

## What the Node does

- continuous source collection;
- bounded work, cursors, checkpoints, and recovery;
- raw source provenance preservation;
- deterministic normalization;
- explicit source semantics;
- historical source-effective and ingestion-time data;
- coverage and source health;
- chart-ready technical measurements;
- versioned API access for BAYKUSH clients.

## What the Node does not do

- store CİTEM private investigations/notes/evidence by default;
- turn IOC/reporting volume into attack count;
- infer attacker origin from infrastructure geolocation;
- produce strategic conclusions or automated attribution;
- allow AI output to become canonical truth.

## Core invariants

1. Unknown is not zero.
2. No coverage is not no activity.
3. Reporting volume is not attack volume.
4. IOC volume is not attack count.
5. EPSS score is not observed exploitation.
6. Historical data availability is not live collection coverage.
7. A mirror is not an independent upstream origin.
8. Bootstrap ingestion must not manufacture current-activity spikes.
9. Every derived value must remain traceable to source provenance.
10. Public/global intelligence remains separate from private analyst workspaces.

## Architecture and runtime documents

- [Architecture](docs/ARCHITECTURE.md)
- [Source Adapter Contract](docs/SOURCE_CONTRACT.md)
- [Canonical Data Model](docs/CANONICAL_DATA_MODEL.md)
- [Collection & Recovery Model](docs/COLLECTION_MODEL.md)
- [Coverage Model](docs/COVERAGE_MODEL.md)
- [Source Semantics](docs/SEMANTICS.md)
- [Technical Measurement Model](docs/MEASUREMENT_MODEL.md)
- [API Contract](docs/API_CONTRACT.md)
- [Source Lineage & Licensing](docs/SOURCE_LINEAGE_AND_LICENSING.md)
- [Security Boundary](docs/SECURITY_BOUNDARY.md)
- [Initial Source Catalog](docs/INITIAL_SOURCE_CATALOG.md)
- [Development Roadmap](docs/ROADMAP.md)
- [NODE-0 Acceptance](docs/ACCEPTANCE.md)
- [NODE-1 Runtime Backbone](docs/NODE_1_RUNTIME.md)
- [NODE-2A Production Source Foundation](docs/NODE_2A_PRODUCTION_FOUNDATION.md)
- [NODE-2B CISA KEV](docs/NODE_2B_CISA_KEV.md)
- [CISA KEV Source Admission](docs/SOURCE_ADMISSION_CISA_KEV.md)
- [NODE-2C NVD CVE](docs/NODE_2C_NVD_CVE.md)
- [NVD CVE Source Admission](docs/SOURCE_ADMISSION_NVD_CVE.md)
- [NODE-2D FIRST EPSS](docs/NODE_2D_FIRST_EPSS.md)
- [FIRST EPSS Source Admission](docs/SOURCE_ADMISSION_FIRST_EPSS.md)
- [NODE-2E ThreatFox](docs/NODE_2E_THREATFOX.md)
- [ThreatFox Source Admission](docs/SOURCE_ADMISSION_THREATFOX.md)
- [NODE-2F MalwareBazaar](docs/NODE_2F_MALWAREBAZAAR.md)
- [MalwareBazaar Source Admission](docs/SOURCE_ADMISSION_MALWAREBAZAAR.md)
- [NODE-2G Shadow Parity & Acceptance](docs/NODE_2G_SHADOW_PARITY.md)
- [NODE-2 Difference Register](docs/NODE_2_DIFFERENCE_REGISTER.md)
- [NODE-2 Final Acceptance Report](docs/NODE_2_ACCEPTANCE_REPORT.md)

## Development sequence

```text
NODE-0  Architecture & Contracts
   ↓
NODE-1  Runtime Backbone
   ↓
NODE-2  Existing Five Sources
   ↓
NODE-3  History + Coverage + Measurements
   ↓
NODE-4  CİTEM Global View v1
   ↓
NODE-5  Source Expansion
   ↓
NODE-6  Internet Infrastructure Telemetry
   ↓
NODE-7  Convergence + Geography + Discovery
   ↓
NODE-8  Operational Hardening
   ↓
NODE-9  ANLAK Projection
```

## Initial source target

NODE-2 targets the sources already understood by CİTEM:

- CISA KEV;
- NVD CVE;
- FIRST EPSS;
- ThreatFox;
- MalwareBazaar.

Additional sources are admitted only after the measurement and CİTEM Global View pipeline is proven.

## Current phase

**NODE-2G — Five-Source Shadow Parity & NODE-2 Final Acceptance**

CISA KEV, NVD CVE, FIRST EPSS, ThreatFox and MalwareBazaar are now implemented as admitted production-shaped source adapters. NODE-2G does not add another provider. It closes the migration phase by proving that all five sources coexist safely on the same runtime and that the Node preserves source identity, semantics, immutable raw truth, checkpoint state, normalization provenance and credential isolation across the full source pack.

NODE-2G introduces a neutral `NODE2G_PARITY_V1` projection so legacy CİTEM collectors and the Node are compared on upstream source identity and critical provider facts rather than incompatible internal database schemas. Same-snapshot CISA/NVD/EPSS membership is strict; ThreatFox and MalwareBazaar live count equality is explicitly not a contract because their legacy and Node collection windows intentionally differ. Every live difference must be classified before cutover.

Automated readiness is exposed through:

```text
npm run test:node2g
npm run node2g:status
npm run node2g:report
npm run node2g:export-node -- SOURCE_KEY
npm run node2g:parity -- node.json citem.json [classifications.json]
```

NODE-2G preserves the legacy CİTEM collectors and historical data for audit/rollback, but after operator acceptance the BAYKUSH Intelligence Node becomes the collection authority for the five public/global sources. CİTEM Node API consumption remains NODE-4; NODE-3 first adds history, coverage and measurement projections above the accepted evidence stream.

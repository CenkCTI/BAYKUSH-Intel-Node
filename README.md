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

**NODE-2C — NVD CVE Production Adapter**

NODE-2C admits NVD CVE API 2.0 through fixed last-modified windows, offset pagination, conservative provider pacing, restart-safe checkpoints, immutable raw CVE revisions, and source-semantic `VULNERABILITY_RECORD` normalization.

NVD remains disabled by default. An API key is optional and header-only. NVD/CISA mirrored fields do not create a second KEV assertion, CVSS is not collapsed into a single risk score, and CPE applicability logic remains intact in raw source truth. FIRST EPSS, ThreatFox, and MalwareBazaar remain out of scope until their respective NODE-2 subphases.

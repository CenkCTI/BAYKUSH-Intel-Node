# BAYKUSH Intelligence Node — Architecture

## 1. Purpose

BAYKUSH Intelligence Node is the shared, continuously running public/global intelligence data infrastructure for the BAYKUSH ecosystem.

It exists so that CİTEM and future modules such as ANLAK do not each collect, parse, normalize, and retain the same open-source data independently.

The Node collects once, preserves source truth, normalizes once, derives bounded machine-readable views, and serves multiple projections.

## 2. Product boundary

The Node is responsible for:

- continuous collection from approved public or explicitly configured sources;
- source identity, lineage, licensing, and collection policy;
- immutable/raw source-record preservation where permitted and useful;
- deterministic deduplication and canonicalization;
- provenance preservation;
- source semantics and epistemic boundaries;
- source-effective and ingestion-time history;
- coverage and source-health history;
- chart-ready technical measurements and distributions;
- public/global entity history;
- versioned read APIs for CİTEM and future BAYKUSH modules.

The Node is not responsible for:

- private CİTEM investigations, notes, evidence, uploads, analyst hypotheses, attribution judgements, or intelligence products;
- organization-internal telemetry unless a future private/edge deployment is explicitly configured;
- strategic conclusions;
- automated attribution;
- global threat-level scoring;
- treating reporting volume as attack volume;
- treating geolocated infrastructure as attacker origin;
- allowing AI output to mutate canonical truth.

## 3. High-level architecture

```text
Public / approved sources
        |
        v
Source Registry + Source Adapters
        |
        v
Collection Runtime
  - scheduler
  - poll/paged poll/snapshot/stream workers
  - bounded work units
  - checkpoints/cursors
  - retries/leases
        |
        v
Raw Source Record Store
        |
        v
Canonicalization + Semantics
        |
        +-----------------------+
        |                       |
        v                       v
Canonical Evidence          Entity History
        |                       |
        +-----------+-----------+
                    |
                    v
        Historical Measurements
        - time series
        - distributions
        - first-seen state
        - source coverage
                    |
                    v
              Versioned API
                    |
          +---------+---------+
          |                   |
          v                   v
      CİTEM TechINT       ANLAK OSINT
      projection          projection (later)
```

## 4. Deployment boundary

The first deployment target is an Oracle VM, but Oracle is not part of the application architecture.

The Node must remain portable to another Linux host or cloud provider without code-level changes.

Deployment assumptions for early phases:

- Linux;
- Docker / Docker Compose;
- Node.js + TypeScript runtime;
- PostgreSQL;
- HTTPS API;
- long-running scheduler/worker processes;
- off-host backup for critical persistent state before production use.

## 5. Process model

NODE-1 may initially run a small number of deployable processes:

- `api`: bounded read-only/public-service API plus operational health endpoints;
- `scheduler`: determines due collection and recovery work;
- `worker`: claims bounded work and executes adapters;
- `measurement-worker`: derives history/measurements from persisted canonical truth.

They may share packages and database access, but responsibilities must remain logically separated so they can be split later without changing contracts.

Streaming telemetry workers are explicitly deferred until NODE-6.

## 6. Data planes

### 6.1 Global intelligence plane

Shared/public data collected by the Node:

- vulnerability records;
- known-exploited vulnerability catalog records;
- exploit-probability scores;
- public IOC reporting;
- public malware sample records;
- public advisories;
- CERT/CSIRT reporting;
- approved Internet infrastructure telemetry;
- approved threat-research reporting;
- canonical context such as ATT&CK.

### 6.2 Private analyst plane

CİTEM-owned/private data remains outside the global Node:

- investigations;
- notes;
- private evidence and uploads;
- private indicators;
- private organization data;
- analyst assessments;
- attribution hypotheses;
- report drafts and intelligence products;
- BYOK/private provider credentials.

A future enterprise/private Node may intentionally host private sources, but that is a separate deployment mode and must not weaken the default public/global boundary.

## 7. Core invariants

1. Unknown is not zero.
2. No coverage is not no activity.
3. Reporting volume is not attack volume.
4. IOC volume is not attack count.
5. EPSS score is not observed exploitation.
6. GeoIP hosting location is not attacker origin.
7. AI output is not canonical truth.
8. Historical data availability is not the same as live collection coverage.
9. A mirror is not an independent source origin.
10. Bootstrap ingestion must not manufacture current-activity spikes.
11. Raw provenance must remain traceable from every derived record and measurement.
12. Source semantics must survive normalization.
13. A source failure must never be silently converted to zero activity.
14. Derived state must be versioned and recomputable.
15. Global public intelligence must remain separate from private analyst workspaces.

## 8. Time model

The Node distinguishes at least:

- `received_at`: when the Node received the source record;
- `published_at`: when the upstream source published the record when known;
- `effective_at`: the source-supported time the record is analytically about when known;
- `upstream_updated_at`: when the upstream source says the record changed when known.

Two analytical axes are first-class:

- `INGESTION_TIME`: Node acquisition/collection chronology;
- `SOURCE_EFFECTIVE_TIME`: chronology represented by the upstream record.

Global activity views should prefer source-effective time when the source contract supports it. Collection health and strict opportunity coverage use ingestion time.

## 9. Projection model

The canonical layer is deliberately module-neutral.

CİTEM consumes a TechINT projection containing technical entities, signals, measurements, and provenance.

ANLAK will later consume an OSINT/strategic projection containing events, actors, organizations, sectors, countries, claims, and other strategic context.

The Node must not force all future intelligence domains into CİTEM's existing schema.

## 10. Phase boundary

NODE-0 defines contracts only.

NODE-0 must not introduce:

- production collectors;
- provider credentials;
- Oracle-specific runtime code;
- stream telemetry;
- anomaly relocation;
- CİTEM integration code;
- ANLAK implementation.

The first implementation phase is NODE-1 Runtime Backbone.
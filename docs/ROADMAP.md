# BAYKUSH Intelligence Node — Development Roadmap

## NODE-0 — Architecture & Contracts

Goal: define the system before implementation.

Deliverables:

- architecture boundary;
- source adapter contract;
- canonical evidence model;
- collection/recovery model;
- coverage model;
- semantics model;
- measurement model;
- Node API contract;
- source lineage/licensing policy;
- security boundary;
- initial source catalog;
- phase roadmap and acceptance criteria.

Exit condition:

A developer can implement NODE-1 without making new product-level assumptions about where data belongs, what a source means, how recovery works, or how CİTEM consumes the Node.

---

## NODE-1 — Runtime Backbone

Goal: implement a production-shaped but source-agnostic long-running runtime.

Planned scope:

- TypeScript/Node.js project foundation;
- PostgreSQL migration system;
- Zod runtime contracts;
- source registry persistence;
- scheduler;
- bounded collection worker;
- collection runs/work units;
- durable checkpoints/cursors;
- raw source-record store;
- deterministic idempotency;
- failure taxonomy;
- leases/retry/recovery;
- source health;
- `TEST_SYNTHETIC` adapter;
- initial `/v1/health` operational API;
- Docker/Docker Compose development runtime;
- CI: lint, typecheck, unit tests, migration tests, Docker build.

Acceptance examples:

- worker/container restart resumes safely;
- repeated work does not duplicate truth;
- cursor cannot advance past persisted records;
- failed source does not corrupt checkpoint;
- stale leases can be reclaimed;
- malformed/oversized test payloads fail safely.

---

## NODE-2 — Existing Five Source Migration

Goal: move the already-understood global source collection capability from CİTEM toward the shared Node.

Sources:

- CISA KEV;
- NVD CVE;
- FIRST EPSS;
- ThreatFox;
- MalwareBazaar.

Scope:

- source-specific adapters;
- recorded fixtures;
- raw identity/fingerprint rules;
- source-effective timestamps;
- canonical normalization;
- semantic mapping;
- pagination/snapshot/cursor policies;
- current terms/licensing admission notes;
- recovery behavior;
- source-specific error classification.

Migration strategy:

Run Node collection in shadow against the existing CİTEM collector long enough to compare:

- record counts;
- canonical keys;
- timestamps;
- payload/revision identity;
- cursor progression;
- semantics;
- provider failure behavior.

Exit condition:

The Node can collect the five global sources independently while CİTEM is closed, with verified parity or documented intentional differences.

---

## NODE-3 — History, Coverage & Measurement Backbone

Goal: transform persisted source truth into the chart-ready technical picture required by CİTEM.

Scope:

- source-effective and ingestion-time histories;
- historical schedule/coverage state;
- initial bootstrap and bounded backfill;
- five-minute/hour/day aggregates as appropriate;
- measurement catalogue;
- measurement points;
- distribution measurements;
- global entity first/last-seen state;
- distinct/first-seen counts;
- current-versus-previous comparison with coverage gates;
- deterministic input fingerprints/recomputation;
- retention/compaction policies.

Exit condition:

With only N1 sources, the Node can provide accurate 24H/7D/30D technical series without interpreting bootstrap ingestion or collection failures as activity.

---

## NODE-4 — CİTEM Integration & TechINT Global View v1

Goal: make CİTEM a fast analyst client of the central Node.

Node scope:

- authenticated/versioned bounded read API;
- source/status endpoints;
- TechINT summary;
- measurements;
- distributions;
- changes;
- coverage;
- entity/provenance drill-down needed by Global View.

CİTEM scope in the CIP repository:

- Node API client;
- local cache/freshness handling where useful;
- `/techint/global`;
- time-range controls;
- source-health/coverage surfaces;
- Vulnerability & Exploitation lane;
- Malware & IOC lane;
- What Changed feed;
- drill-down from chart bucket to source/entity/provenance;
- existing deterministic anomaly layer as an optional overlay, not a prerequisite.

Critical acceptance:

- Global View remains useful with anomaly analysis disabled;
- a first-time user receives historical/current data from the Node rather than an empty dashboard where upstream history exists;
- CİTEM may be closed for two days while Node collection continues, then show those two days on reopen.

---

## NODE-5 — Source Expansion

Goal: broaden the technical picture after the measurement/UI pipeline is proven.

### NODE-5A — Malware / IOC

Priority candidates:

- URLhaus;
- SSLBL;
- optional Feodo depending on admission-time usefulness.

### NODE-5B — Advisory / vulnerability

- GitHub Advisory Database;
- CISA ICS advisories.

### NODE-5C — CERT / regional reporting

- CERT-EU;
- JPCERT/CC / JVN;
- later additional national CERT/CSIRT sources.

### NODE-5D — Context

- MITRE ATT&CK context integration.

### NODE-5E — selected vendor PSIRTs / threat research

Only after source admission, terms, semantic class, and measurement value are explicitly documented.

Exit condition:

New sources can be added through the established adapter/admission process without changing the core collection architecture.

---

## NODE-6 — Internet Infrastructure Telemetry

Goal: add direct/near-direct technical Internet infrastructure movement rather than only cyber-reporting repositories.

Primary target:

- RIPE RIS/BGP telemetry through a dedicated stream worker.

Scope:

- stream connection/reconnect/backpressure;
- bounded in-memory/window accumulation;
- 1m/5m/hour/day aggregate pipeline;
- high-volume retention policy;
- BGP announcements/withdrawals;
- distinct prefixes/ASNs;
- carefully defined routing-change measurements;
- stream coverage/gaps;
- separate stream health diagnostics.

Experimental restricted sources may be added only under explicit licensing policy.

Exit condition:

Global View contains an `Internet Infrastructure` lane whose measurements remain distinguishable from threat-reporting activity.

---

## NODE-7 — Convergence, Lineage, Geography & Discovery

Goal: make multi-source movement discoverable without automating unsupported conclusions.

Scope:

- canonical entity overlap;
- source-system overlap;
- upstream-origin-aware convergence;
- related-record time windows;
- composition-change discovery;
- top movers/new entities;
- concurrent technical movement;
- geographic assertions with explicit basis;
- world-map API data.

Geo classes:

- observed infrastructure location;
- reported target;
- reported activity.

Forbidden shortcut:

Geolocated infrastructure must never become attacker origin by default.

Exit condition:

An analyst can see that multiple distinct technical sources moved around a common subject and drill to the evidence without the Node declaring attribution or strategic meaning.

---

## NODE-8 — Operational Hardening

Goal: operate the Node continuously and safely on small infrastructure, starting with Oracle but remaining provider-independent.

Scope:

- hardened Docker images;
- secrets management;
- HTTPS/reverse proxy;
- API authentication/authorization;
- rate limiting;
- network/SSRF hardening;
- database-role separation;
- backup/restore;
- off-host encrypted backups;
- retention/compaction operations;
- disk/resource monitoring;
- source freshness monitoring;
- worker/scheduler heartbeats;
- schema/provider-change diagnostics;
- load and fault testing;
- deployment/recovery runbook.

Fault acceptance includes:

- VM restart;
- Docker restart;
- database restart;
- Internet outage;
- DNS failure;
- rate limit;
- provider timeout/error;
- provider schema change;
- disk pressure;
- worker crash/stale lease.

Exit condition:

A replaceable host can resume collection from durable state without losing provenance or silently fabricating coverage.

---

## NODE-9 — ANLAK Projection

Goal: reuse the same collection/canonical infrastructure for strategic OSINT without turning the TechINT model into a universal ontology.

Scope to be designed later:

- OSINT event projection;
- actors/organizations;
- countries/regions;
- sectors;
- claims;
- policy/economic/energy context;
- strategic-source semantics;
- `/v1/osint/...` APIs;
- ANLAK client integration.

The same source record may support different projections. Collection and raw provenance are not duplicated.

Exit condition:

ANLAK can consume the shared Node while CİTEM remains a focused technical-intelligence workspace.

---

# Roadmap-wide acceptance principles

Every phase preserves:

1. unknown != zero;
2. no coverage != no activity;
3. reporting volume != attack volume;
4. source semantics survive normalization;
5. provenance remains traversable;
6. derived state is deterministic/versioned where possible;
7. public/global Node data stays separate from private analyst data;
8. Oracle is a deployment target, not an application dependency;
9. AI is assistant context, never canonical truth authority;
10. each new source/feature must improve an analyst-observable technical question rather than merely increase record count.
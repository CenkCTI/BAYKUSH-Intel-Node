# NODE-8 — Operational Hardening & Production Deployment

## Mission

NODE-8 converts the BAYKUSH Intelligence Node from a production-shaped development runtime into a continuously operable production service on a small replaceable host. Oracle Cloud is the first deployment target, not an application dependency.

The phase preserves every semantic invariant established by NODE-0 through NODE-7. Operational failure must never be converted into fabricated intelligence, false zeroes, false coverage, or unsupported conclusions.

## Exit condition

NODE-8 is complete only when a clean replaceable host can be provisioned and the Node can:

- start from an exact immutable application image;
- persist PostgreSQL and recovery state across service and host restarts;
- expose only an HTTPS reverse-proxy edge;
- keep PostgreSQL and internal service ports private;
- keep application/provider/database credentials outside Git and browser-visible surfaces;
- operate runtime services with least-privilege database roles;
- take encrypted off-host backups and restore them onto a fresh PostgreSQL instance;
- resume collection from durable checkpoints without duplicating or inventing truth;
- surface provider, schema, worker, disk, backup and source-freshness failures explicitly;
- survive the defined restart/network/provider/disk/worker fault matrix;
- serve CİTEM through the existing server-to-server Node boundary;
- produce machine-readable production-acceptance evidence.

## Authority boundary

NODE-8 changes how the Node is built, deployed, authenticated, operated and recovered. It does not change the meaning of technical evidence.

The following remain forbidden:

- private CİTEM investigations or analyst notes becoming shared Node truth;
- infrastructure geolocation becoming attacker origin;
- reporting volume becoming attack volume;
- no coverage becoming zero activity;
- bootstrap/recovery/backfill becoming current activity;
- scoring/context feeds becoming independent convergence breadth;
- AI becoming canonical truth authority.

## Production topology

```text
Internet
   |
   | 80/443
   v
Reverse proxy / TLS edge
   |
   | Docker edge network
   v
Node API
   |
   | Docker backend network
   +---------------- PostgreSQL
   +---------------- scheduler
   +---------------- collector worker
   +---------------- normalizer
   +---------------- measurement worker
   +---------------- discovery worker
   +---------------- RIPE stream worker
   +---------------- recovery worker
```

Only the reverse proxy has public HTTP(S) host bindings. PostgreSQL and the Node API do not publish host ports in the production Compose model.

## Durable state

Production state is divided into three classes:

1. **Authoritative/durable PostgreSQL state** — source definitions, collection state, immutable raw/canonical evidence, entity history, measurements, routing history, discovery state, migration ledger and operational state.
2. **Bounded recovery staging** — replaceable MRT/recovery artifacts used by recovery execution and governed by explicit retention/disk-pressure controls.
3. **Ephemeral process state** — queues, temporary files and caches that may be discarded and reconstructed.

Secrets are not durable application data and must not be copied into database or backup payloads.

## Deployment invariants

- Production runs an exact image tag or digest, never an ambiguous local source tree.
- Production deployment must not require compiling application source on the host.
- Migrations execute as a one-shot pre-start gate and must fail closed.
- Normal runtime services never receive migration capability.
- A failed deployment must not automatically destroy the previous database or persistent volumes.
- `docker compose down -v` is never a deployment or rollback operation.
- Destructive schema changes require an expand/contract release sequence.

## NODE-8 subphases

### 8A — Production foundation & supply chain

- separate production Compose model;
- reverse-proxy/TLS boundary;
- provider-independent host layout;
- exact image release contract;
- GHCR build/publish workflow;
- systemd bootstrap/restart contract;
- preflight/deploy/smoke tooling;
- production deployment documentation.

### 8B — Secrets, API authentication & edge controls

- file-backed secret loading;
- multi-credential service authentication with scopes;
- zero-downtime credential rotation;
- safe request identity/audit context;
- API rate limits;
- CORS/security headers and request bounds;
- credential redaction tests.

### 8C — PostgreSQL least privilege

- migrator/API/ingest/projection/stream/recovery roles;
- grants encoded as migrations;
- role-specific production connection strings;
- negative privilege acceptance tests.

### 8D — Container/runtime hardening

- read-only root filesystems where compatible;
- `no-new-privileges`;
- capability drop;
- tmpfs/write-path allowlists;
- CPU/memory/PID bounds;
- log rotation;
- production resource envelope.

### 8E — Network & upstream hardening

- admitted upstream endpoint policy;
- redirect, timeout, response-size and decompression bounds;
- private/link-local/metadata destination rejection for generic fetch paths;
- controlled provider error-body handling;
- explicit DNS/network failure taxonomy.

### 8F — Backup, restore & retention

- encrypted off-host PostgreSQL backups;
- backup age/failure state;
- documented retention policy;
- restore onto a fresh database;
- integrity/continuity acceptance;
- disk-pressure response.

### 8G — Observability & operations

- structured operational logs;
- service/worker heartbeat surfaces;
- source freshness/error visibility;
- queue/backlog, database, disk and backup health;
- provider schema-change diagnostics;
- operator runbook.

### 8H — Release, migration & rollback

- pre-deploy backup gate;
- one-shot migration gate;
- immutable image release metadata;
- expand/contract migration policy;
- rollback of application image without destructive database rollback;
- deployment evidence.

### 8I — Fault, load & resilience acceptance

- VM/Docker/PostgreSQL restart;
- Internet/DNS/provider failures;
- HTTP 429/timeouts/schema changes;
- disk pressure;
- worker crash/stale lease;
- backup target outage;
- bounded 24H/7D/30D API load under active collection.

### 8J — CİTEM production cutover & real-host closure

- production CİTEM server-side Node URL/credential configuration;
- degraded-state behavior when Node is unavailable;
- real Oracle-host acceptance;
- restore/reboot/network-boundary verification;
- final `NODE8_PRODUCTION_ACCEPTANCE_V1` evidence.

## Release evidence

Every accepted production release records at minimum:

```json
{
  "schemaVersion": "NODE8_PRODUCTION_ACCEPTANCE_V1",
  "accepted": true,
  "nodeCommit": "<git sha>",
  "imageDigest": "sha256:<digest>",
  "deploymentTarget": "oracle-vm",
  "restoreVerified": true,
  "rebootRecoveryVerified": true,
  "networkBoundaryVerified": true,
  "citemConsumerVerified": true
}
```

Oracle-specific identifiers may appear in deployment evidence, but application code and persistence semantics remain provider-independent.

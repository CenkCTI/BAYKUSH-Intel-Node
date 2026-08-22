# NODE-8D — Runtime and container hardening

## Mission

Turn the production Compose stack from a packaging topology into a bounded runtime security boundary. A compromised Node process should have a materially smaller kernel/filesystem/resource surface and should not be able to convert an application bug into unrestricted host-like container behavior.

## Node service baseline

All Node application containers (`migrate`, API, scheduler, collector worker, backfill, normalizer, measurement, discovery, stream and recovery) inherit the same minimum controls:

- the image-defined non-root `node` user remains authoritative;
- `init: true` for signal forwarding and zombie reaping;
- read-only root filesystem;
- `no-new-privileges`;
- all Linux capabilities dropped;
- bounded PID count;
- bounded memory and CPU;
- bounded `/tmp` tmpfs with `noexec,nosuid,nodev`;
- bounded JSON log rotation;
- explicit stop grace period;
- only declared persistent or secret mounts.

Per-service resource ceilings may be overridden through non-secret runtime configuration, but production may not disable the presence of a bound.

## Resource classes

The defaults intentionally distinguish light control-plane services from heavier data-plane services. API/migration receive moderate headroom, collection/projection workers receive more memory, and routing stream/recovery workers receive the largest defaults. These are safety ceilings rather than reservations or performance SLAs and will be calibrated during NODE-8I load acceptance.

## Caddy exception model

Caddy also uses read-only rootfs, no-new-privileges, bounded resources and drops all default capabilities. It explicitly regains only `NET_BIND_SERVICE` because the edge must bind host ports 80/443. `/data` and `/config` remain the declared writable volumes required for certificate/state management.

## PostgreSQL exception model

The official PostgreSQL image is deliberately not forced into the common read-only-rootfs/capability profile because its bootstrap and database runtime have different filesystem/process requirements. PostgreSQL is still internal-only, has a persistent data volume, PID/CPU/memory bounds and a longer graceful-stop interval. NODE-8D does not claim that a database container is equivalent to a stateless Node process.

## Live audit

`deploy/production/scripts/runtime-audit.sh` inspects running containers after deployment. It verifies for Node services:

- non-root image user;
- read-only root filesystem;
- no-new-privileges;
- `CapDrop=ALL`;
- positive PID, memory and CPU limits.

It verifies PostgreSQL resource bounds separately and intentionally treats the completed one-shot migration container as optional after deploy.

## Acceptance

NODE-8D is accepted only when production Compose validation and a running-host audit establish the declared controls and all previous NODE semantics/tests still pass. A service that genuinely requires an additional capability or writable path must receive a narrow documented exception; globally disabling hardening is not an acceptable workaround.

# NODE-8 production deployment contract

## Purpose

This contract defines the production boundary for BAYKUSH Intelligence Node before any provider-specific host provisioning is accepted.

## Host layout

The supported initial layout is:

```text
/opt/baykush-node/
  compose.yml
  Caddyfile
  scripts/

/etc/baykush/
  runtime.env

systemd:
  baykush-node.service
```

`/opt/baykush-node` contains public deployment descriptors only. `/etc/baykush` contains host-private runtime configuration and, after NODE-8B, file-backed secrets.

## Image contract

Production must set `BAYKUSH_NODE_IMAGE` to an image published by CI. A digest reference is preferred:

```text
ghcr.io/cenkcti/baykush-intel-node@sha256:<digest>
```

A mutable development tag such as `latest` is not an accepted production release identity.

The deployment host does not compile TypeScript, install npm dependencies, build the Rust MRT decoder or build the application image.

## Network contract

Public host bindings are limited to the reverse proxy:

- TCP 80 where required for redirect/ACME;
- TCP 443;
- UDP 443 when HTTP/3 is enabled.

The Node API listens on Docker-internal port 8080 and is not host-published. PostgreSQL is attached only to the internal backend network and has no host port.

Administrative SSH is a host/cloud-firewall concern and must be restricted independently; it is not part of the Compose application network.

## Start order

1. PostgreSQL starts and becomes healthy.
2. The one-shot migration service runs.
3. A failed migration prevents dependent runtime services from starting.
4. API/workers start only after migration success.
5. Caddy starts against the healthy API.

## Deployment procedure

The operator or automation executes:

```text
preflight -> image pull -> PostgreSQL -> migration gate -> runtime start -> health -> authenticated smoke
```

A deployment never removes named volumes as part of normal upgrade or rollback.

## Rollback boundary

Application rollback means selecting a previously accepted image digest and starting the runtime again. Database rollback is not automatic.

Migrations therefore follow forward-only expand/contract compatibility. Once an applied migration has shipped to production, its file/hash is immutable under the existing migration ledger rules.

## Provider independence

Oracle Cloud is the first real-host acceptance target. The production artifacts intentionally depend only on:

- a Linux host;
- Docker Engine;
- the Docker Compose plugin;
- routable DNS;
- persistent disk;
- an off-host backup destination introduced in NODE-8F.

No Oracle SDK, queue, database or proprietary runtime primitive is required by the application.

## Production preflight

`deploy/production/scripts/preflight.sh` verifies at minimum:

- Docker/Compose availability;
- deployment files exist;
- runtime env permissions/ownership;
- image and hostname are configured;
- Compose parses;
- no unexpected public host ports are introduced.

## Smoke acceptance

`smoke-test.sh` verifies:

- the public HTTPS `/v1/health` endpoint returns an OK envelope;
- a protected endpoint accepts the configured server-to-server credential.

Later NODE-8 subphases extend this smoke contract with scoped credentials, role separation, backup age, operational status and CİTEM production acceptance.

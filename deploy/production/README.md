# BAYKUSH Intelligence Node — production host bootstrap

This directory is the provider-independent production deployment surface introduced by NODE-8A.

## Host prerequisites

Initial acceptance target:

- Ubuntu 24.04 LTS or equivalent supported Linux;
- Docker Engine;
- Docker Compose plugin;
- systemd;
- a DNS name resolving to the host;
- persistent host storage;
- cloud/host firewall controls.

Oracle Cloud is the first real-host target, but no Oracle-specific runtime dependency is used.

## Required network policy

Cloud firewall and host firewall must both enforce:

- `443/tcp` from intended CİTEM/Internet clients;
- `80/tcp` only where required for ACME/HTTPS redirect;
- `22/tcp` only from explicitly approved administration addresses;
- no public `5432/tcp`;
- no public `8080/tcp`;
- deny other unsolicited inbound traffic.

## Install deployment descriptors

Copy the contents of this directory to `/opt/baykush-node`:

```text
/opt/baykush-node/
  compose.yml
  Caddyfile
  scripts/
```

Copy `env.example` to `/etc/baykush/runtime.env`, populate real values on the host, then enforce:

```text
owner: root:root
mode: 0600
```

Do not commit the populated file.

NODE-8B replaces raw secret values in this env file with file-backed secret mounts. Until that PR is merged, this deployment descriptor is an architecture/acceptance foundation and must not be treated as final secret handling.

## Image identity

Set `BAYKUSH_NODE_IMAGE` to an image published by the `Publish NODE image` workflow. Prefer the digest identity recorded by the workflow artifact:

```text
ghcr.io/cenkcti/baykush-intel-node@sha256:<digest>
```

## Preflight

Run:

```text
sudo bash /opt/baykush-node/scripts/preflight.sh
```

The preflight rejects missing prerequisites, unsafe runtime-env ownership/permissions, unconfigured image/hostname, invalid Compose and unexpected host-published service ports.

## Deploy

After the later secret/backup gates are present, the normal deployment entry point is:

```text
sudo bash /opt/baykush-node/scripts/deploy.sh
```

NODE-8H extends this script with mandatory pre-deploy backup/release evidence. NODE-8A already establishes the ordering contract:

```text
preflight -> pull -> PostgreSQL -> migrate -> services -> health -> authenticated smoke
```

## systemd

Install `systemd/baykush-node.service` as `/etc/systemd/system/baykush-node.service`, reload systemd and enable it for boot. The unit performs Compose validation before startup and uses the same `/etc/baykush/runtime.env` contract.

The host-reboot acceptance in NODE-8I must demonstrate that no interactive SSH action is required for the Node to return to a healthy collection state.

## Prohibited operational shortcuts

Never use the following as part of normal deploy/rollback/recovery:

- deleting the PostgreSQL volume;
- `docker compose down -v`;
- editing an already-applied migration;
- rebuilding source manually on the production host;
- copying real credentials into this repository;
- exposing PostgreSQL or port 8080 to the public Internet.

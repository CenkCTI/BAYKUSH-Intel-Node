# BAYKUSH Intelligence Node — production host bootstrap

This directory is the provider-independent production deployment surface introduced by NODE-8.

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

Copy `env.example` to `/etc/baykush/runtime.env`, populate only paths/non-secret configuration, then enforce:

```text
owner: root:root
mode: 0600
```

## Provision host-private secrets

Create `/etc/baykush/secrets` as `root:root` mode `0700`. Required files are:

```text
postgres_password
database_url
api_credentials.json
smoke_api_token
```

Each file must be `root:root` and mode `0400` or `0600`. Optional provider files may be added only when configured in `runtime.env`:

```text
nvd_api_key
threatfox_auth_key
malwarebazaar_auth_key
ipinfo_lite_token
```

Use `api-credentials.example.json` only as a schema example. Generate random real tokens out of band and never commit the populated registry. `smoke_api_token` is a host-only copy of one active credential carrying both `techint:read` and `sources:read`; it is not mounted into the application containers.

The `database_url` file is the transitional shared database URL. NODE-8C replaces it with role-specific connection files without returning raw credentials to `runtime.env`.

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

The preflight rejects missing prerequisites, unsafe runtime-env or secret permissions/ownership, missing required secrets, unconfigured image/hostname, invalid Compose and unexpected host-published service ports.

## Deploy

After the later backup gate is present, the normal deployment entry point is:

```text
sudo bash /opt/baykush-node/scripts/deploy.sh
```

NODE-8H extends this script with mandatory pre-deploy backup/release evidence. The ordering contract is already fixed:

```text
preflight -> pull -> PostgreSQL -> migrate -> services -> health -> authenticated smoke
```

## API credential rotation

Do not replace the only active token in one step. Use additive rotation:

```text
A -> registry A+B -> update CİTEM to B -> verify -> registry B
```

Full rules are in `docs/NODE_8_SECRETS_AND_API_SECURITY.md`.

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
- placing bearer/provider/database secrets directly in `runtime.env`;
- exposing PostgreSQL or port 8080 to the public Internet.

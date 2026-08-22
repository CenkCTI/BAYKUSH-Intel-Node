# NODE-8F — Backup, restore and retention

## Mission

Make the production host replaceable. A VM or local Docker-volume loss must not erase the durable Node truth, collection checkpoints, measurement/discovery state or migration history.

## Backup model

The baseline is a PostgreSQL custom-format `pg_dump` plus a small immutable manifest and migration-ledger snapshot. Those artifacts are written into a temporary root-only staging directory and immediately committed to an encrypted restic repository.

Production repositories must be off-host. Local restic repositories are rejected unless `BACKUP_ALLOW_LOCAL_REPOSITORY=true`, which exists only for isolated acceptance/testing. Supported production repository classes include S3-compatible, REST and other restic remote backends.

Restic encryption uses `RESTIC_PASSWORD_FILE`; the password never enters Git or Compose. Optional object-storage transport credentials live in `/etc/baykush/backup.env`, root-owned mode 0600/0400, and are loaded only by the host backup/restore process.

## Backup content

Included:

- PostgreSQL database state;
- raw/canonical public source evidence;
- collection/scheduler/checkpoint state;
- measurement/discovery/routing/recovery database state;
- `node_schema_migrations` ledger;
- manifest and SHA-256 checksums.

Excluded:

- API bearer credentials;
- provider API keys/tokens;
- database password/URL files;
- restic repository password;
- backup transport credentials;
- transient recovery/download staging artifacts outside PostgreSQL.

The manifest explicitly records `includesSecrets: false`; restore rejects a manifest that does not assert this contract.

## Schedule and retention

`baykush-backup.timer` runs nominally every six hours with persistent catch-up and a small randomized delay. Initial retention:

- last 8 snapshots;
- 7 daily;
- 4 weekly;
- 6 monthly.

`restic forget` is run on each backup. Expensive pack pruning is opt-in (`BACKUP_RUN_PRUNE=true`) and should be scheduled/observed separately on a small host.

The six-hour schedule establishes an initial **RPO target <= 6 hours**. This is an engineering acceptance target, not an external SLA.

## Restore model

`restore.sh` requires `NODE8_RESTORE_CONFIRM=YES`. The default destination is the isolated `baykush_restore_verify` database, never the production database.

The restore path:

1. retrieve the encrypted snapshot;
2. locate dump/manifest/migration ledger;
3. verify manifest version and SHA-256 hashes;
4. recreate an isolated target database;
5. `pg_restore` with no owner/ACL replay;
6. verify migration ledger exists;
7. query raw/canonical counts;
8. write `NODE8_RESTORE_ACCEPTANCE_V1` evidence.

Restoring over the production database has a second guard, `NODE8_RESTORE_PRODUCTION_CONFIRM=YES`. Normal acceptance must use an isolated database.

## Host replacement runbook

A real disaster recovery is:

1. provision a fresh compatible Linux host;
2. install Docker/Compose, restic and production deployment files;
3. recreate host-private secrets out-of-band;
4. start an empty PostgreSQL service;
5. restore the accepted snapshot;
6. apply any newer forward migrations;
7. provision/rotate runtime DB roles;
8. start Node runtime services;
9. run runtime/network/auth/ops smoke acceptance;
10. confirm checkpoints resume without duplicate canonical truth or fabricated coverage.

Secrets are deliberately not restored from the database backup. They are a separate operational custody domain.

## Retention classes

- canonical/raw public-source provenance: durable by default;
- measurement/discovery/history: durable/rebuildable but backed up with DB state;
- high-volume routing raw material: bounded by the existing stream retention policy;
- routing recovery artifacts: transient and bounded by recovery retention;
- container logs: bounded by Compose log rotation;
- backup snapshots: governed by restic retention above.

## Acceptance

NODE-8F is accepted only after an off-host encrypted snapshot is created and an isolated restore from that repository succeeds with checksum and migration-ledger verification. Merely seeing a successful backup command is insufficient.

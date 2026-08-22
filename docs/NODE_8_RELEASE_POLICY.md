# NODE-8H — Release, migration and rollback policy

## Mission

Make production deployment deterministic and recoverable while keeping database history forward-only. Release operations must be serialized, backed up before schema change, identified by immutable image digest and accepted only after smoke/security/runtime gates.

## Deploy transaction

`deploy.sh` now acts as the authoritative production release transaction:

1. acquire an exclusive host deployment lock;
2. run preflight;
3. require a digest-pinned image;
4. detect an existing durable database;
5. if durable state exists, create an encrypted off-host backup **before** migration;
6. pull exact images;
7. start/verify PostgreSQL;
8. run the one-shot forward migration service;
9. create/rotate least-privilege runtime DB logins;
10. start runtime services;
11. wait for API liveness;
12. run authenticated Node smoke;
13. run live container hardening audit;
14. run network ingress audit;
15. write immutable release evidence and atomically update `current.json`.

A fresh empty database may skip the pre-migration backup because no durable Node state yet exists. Once the migration ledger exists, the backup gate is mandatory.

## Immutable release identity

Production `BAYKUSH_NODE_IMAGE` must be `repository@sha256:<digest>`. Tags alone are insufficient for accepted releases. `set-release-image.sh` changes only that value and rewrites the root-owned runtime environment atomically while preserving its mode.

`NODE8_RELEASE_EVIDENCE_V1` stores:

- accepted image digest;
- previous accepted image digest;
- migration-ledger SHA-256;
- production Compose SHA-256;
- pre-deploy backup-gate result;
- smoke/runtime/network acceptance flags;
- explicit secret exclusion.

Release evidence lives under `/var/lib/baykush/releases` and is operational evidence, not canonical intelligence data.

## Migration policy

Production migrations are:

- forward-only;
- immutable after release;
- transactional where PostgreSQL permits;
- tested against populated databases;
- additive/expand-contract across at least one application rollback window.

Destructive schema changes must not be combined with the first application release that stops using the old structure. The expected lifecycle is:

1. **expand** — add new structures while old readers/writers remain valid;
2. **migrate/backfill** — populate and verify;
3. **switch** — new application uses the new structure while old release still tolerates schema;
4. **contract later** — remove obsolete structures only after rollback window closes.

There is no automated SQL down-migration path.

## Rollback

`rollback.sh` is an application-image rollback only. It requires two explicit confirmations:

- `NODE8_ROLLBACK_CONFIRM=YES`;
- `NODE8_ROLLBACK_SCHEMA_COMPATIBLE=YES`.

It then:

1. acquires the same deploy lock;
2. reads current/previous digest evidence;
3. creates an encrypted backup of the current database;
4. atomically selects the previous digest;
5. pulls/restarts application services **without** reverting database migrations;
6. runs health, authenticated smoke, runtime and network audits;
7. writes new release evidence.

If the previous application is not compatible with the current forward schema, rollback is not allowed; recovery must use a newer compatible image or an explicit disaster-restore procedure.

## Acceptance

NODE-8H is accepted when concurrent deploys are rejected, durable-state migration cannot proceed without backup, digest identity is enforced, release evidence is produced only after all post-start gates pass, and a compatible prior application image can be restored without rewriting database history.

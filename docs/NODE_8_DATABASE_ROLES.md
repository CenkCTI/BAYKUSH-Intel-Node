# NODE-8C — PostgreSQL least-privilege runtime boundary

## Mission

Remove the shared production database credential. A compromise of one Node process must not automatically grant the database authority of every other process or the migration owner.

## Stable capability roles

Migration `0039_node8c_runtime_database_roles.sql` creates NOLOGIN capability roles:

- `baykush_api` — read-only global/public Node state;
- `baykush_ingest` — collection, normalization, source state and backfill writes;
- `baykush_projection` — measurement, coverage, discovery, convergence and geography writes;
- `baykush_stream` — live routing/stream writes;
- `baykush_recovery` — routing recovery writes plus narrowly bounded stream/recovery retention delete authority.

The roles are deliberately NOLOGIN. They express database authority, not credentials.

## Rotating login roles

`deploy/production/scripts/provision-db-roles.sh` creates or rotates:

- `baykush_api_runtime` -> member of `baykush_api`;
- `baykush_ingest_runtime` -> member of `baykush_ingest`;
- `baykush_projection_runtime` -> member of `baykush_projection`;
- `baykush_stream_runtime` -> member of `baykush_stream`;
- `baykush_recovery_runtime` -> member of `baykush_recovery`.

All are `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`. The API login also has `default_transaction_read_only=on` as a defense-in-depth control in addition to SQL grants. Runtime logins receive bounded statement and idle-transaction timeouts.

Passwords are random 64-character hexadecimal values generated on the production host. They are stored only in root-owned, read-only secret files and may be rotated by rerunning the provisioning script. Generated connection URL files remain root-owned/group-readable by the dedicated non-interactive secret GID.

## Migration authority

`db_migrator_url` is a separate host secret and is consumed only by the one-shot `migrate` service. It points at the database owner/bootstrap migration principal. No long-lived runtime service receives that URL.

NODE-8C intentionally does not attempt automatic down-migrations or transfer database ownership to runtime roles. Release/rollback policy is handled in NODE-8H.

## Production service mapping

| Service | Database secret | Capability |
| --- | --- | --- |
| migrate | `db_migrator_url` | migration owner only |
| api | `db_api_url` | read only |
| scheduler | `db_ingest_url` | ingestion plane |
| worker | `db_ingest_url` | ingestion plane |
| backfill | `db_ingest_url` | ingestion plane |
| normalizer | `db_ingest_url` | ingestion plane |
| measurement | `db_projection_url` | projection plane |
| discovery | `db_projection_url` | projection plane |
| stream-worker | `db_stream_url` | stream plane |
| recovery-worker | `db_recovery_url` | recovery plane |

No runtime service uses the transitional shared `database_url` from NODE-8B.

## Grant policy

All runtime capability roles may read existing public Node state required for correlation and provenance. Mutation is split by table family. Future migrations must explicitly grant new table families; NODE-8C deliberately does not install `ALTER DEFAULT PRIVILEGES` that could silently widen future access.

Existing immutable-table triggers remain authoritative. A role that can append an immutable truth record does not gain permission to rewrite an existing immutable revision merely because it has table-level `UPDATE`; the database immutability guard continues to reject the mutation.

## Deployment ordering

Fresh or normal deploy ordering becomes:

1. production preflight;
2. pull immutable images;
3. start PostgreSQL;
4. run migration with `db_migrator_url`;
5. create/rotate least-privilege runtime logins;
6. start runtime services;
7. API health and authenticated smoke.

This ordering lets migration 0039 establish capability roles before login membership is provisioned.

## Acceptance criteria

NODE-8C is accepted only when all of the following are demonstrated:

- production Compose contains no shared `DATABASE_URL` or shared `database_url` runtime secret;
- API, ingest, projection, stream and recovery services resolve different database URL files;
- runtime capability roles are NOLOGIN, non-superuser and cannot create databases/roles;
- API can SELECT required Node state;
- API cannot INSERT, UPDATE, DELETE or CREATE schema objects;
- API login is transaction-read-only by default;
- ingestion cannot perform DDL;
- projection/stream/recovery writes are bounded to their declared table families;
- only recovery has the declared retention DELETE surface;
- no runtime service receives `db_migrator_url`;
- database passwords/URLs are absent from Git, Compose environment values, API responses and browser code;
- the full NODE-0–7 regression suite still passes.

Any permission missing from a legitimate runtime path is fixed by an explicit, reviewable grant. Broad superuser/shared-owner fallback is not an acceptable fix.

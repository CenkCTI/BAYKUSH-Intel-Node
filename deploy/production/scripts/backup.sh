#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/baykush/backup.env}

fail() { printf 'backup: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root on the production host'
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
  mode=$(stat -c '%a' "$BACKUP_ENV_FILE")
  owner=$(stat -c '%U:%G' "$BACKUP_ENV_FILE")
  [[ "$owner" == root:root && ( "$mode" == 600 || "$mode" == 400 ) ]] || fail "$BACKUP_ENV_FILE must be root:root mode 0600/0400"
  # shellcheck disable=SC1090
  source "$BACKUP_ENV_FILE"
fi
set +a

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${RESTIC_PASSWORD_FILE:?RESTIC_PASSWORD_FILE is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
POSTGRES_DB=${POSTGRES_DB:-baykush}
BACKUP_STAGING_ROOT=${BACKUP_STAGING_ROOT:-/var/lib/baykush/backup-staging}
BACKUP_ALLOW_LOCAL_REPOSITORY=${BACKUP_ALLOW_LOCAL_REPOSITORY:-false}

for command in docker restic sha256sum node stat mktemp; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -f "$RESTIC_PASSWORD_FILE" ]] || fail 'RESTIC_PASSWORD_FILE does not exist'

case "$RESTIC_REPOSITORY" in
  s3:*|rest:*|rclone:*|azure:*|gs:*|b2:*) ;;
  *) [[ "$BACKUP_ALLOW_LOCAL_REPOSITORY" == true ]] || fail 'production backup repository must be off-host (set BACKUP_ALLOW_LOCAL_REPOSITORY=true only for isolated tests)' ;;
esac

mkdir -p "$BACKUP_STAGING_ROOT"
chmod 0700 "$BACKUP_STAGING_ROOT"
stage=$(mktemp -d "$BACKUP_STAGING_ROOT/run.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf 'backup: creating consistent PostgreSQL custom-format dump\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-acl > "$stage/baykush.dump"
[[ -s "$stage/baykush.dump" ]] || fail 'pg_dump produced an empty backup'

printf 'backup: recording migration ledger\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT filename || chr(9) || sha256 FROM node_schema_migrations ORDER BY filename' > "$stage/migrations.txt"

dump_sha=$(sha256sum "$stage/baykush.dump" | awk '{print $1}')
migration_sha=$(sha256sum "$stage/migrations.txt" | awk '{print $1}')
node - "$stage/manifest.json" "$timestamp" "$dump_sha" "$migration_sha" <<'NODE'
const fs = require('node:fs');
const [path, createdAt, dumpSha256, migrationLedgerSha256] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({
  schemaVersion: 'NODE8_BACKUP_MANIFEST_V1',
  createdAt,
  databaseDump: 'baykush.dump',
  dumpSha256,
  migrationLedger: 'migrations.txt',
  migrationLedgerSha256,
  includesSecrets: false,
}, null, 2) + '\n', { mode: 0o600 });
NODE

printf 'backup: writing encrypted off-host restic snapshot\n'
(
  cd "$stage"
  restic backup baykush.dump migrations.txt manifest.json \
    --tag baykush-node --tag node8 --host "$(hostname)" >/dev/null
)

restic snapshots --latest 1 --tag baykush-node --json >/dev/null

# Retention removes snapshot references. Pruning pack data is deliberately
# separated/optional because prune can be expensive on a small host.
restic forget --tag baykush-node \
  --keep-last "${BACKUP_KEEP_LAST:-8}" \
  --keep-daily "${BACKUP_KEEP_DAILY:-7}" \
  --keep-weekly "${BACKUP_KEEP_WEEKLY:-4}" \
  --keep-monthly "${BACKUP_KEEP_MONTHLY:-6}" >/dev/null
if [[ "${BACKUP_RUN_PRUNE:-false}" == true ]]; then
  restic prune >/dev/null
fi

printf 'backup: PASS created_at=%s dump_sha256=%s\n' "$timestamp" "$dump_sha"

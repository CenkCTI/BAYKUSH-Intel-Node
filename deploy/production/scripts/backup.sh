#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/baykush/backup.env}

fail() { printf 'backup: %s\n' "$*" >&2; exit 1; }
if [[ ${EUID:-$(id -u)} -ne 0 && "${NODE8_ISOLATED_TEST_MODE:-false}" != true ]]; then
  fail 'must run as root on the production host'
fi
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

for command in docker restic sha256sum node stat mktemp flock; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done
[[ -f "$RESTIC_PASSWORD_FILE" ]] || fail 'RESTIC_PASSWORD_FILE does not exist'
password_mode=$(stat -c '%a' "$RESTIC_PASSWORD_FILE")
password_owner=$(stat -c '%U:%G' "$RESTIC_PASSWORD_FILE")
if [[ "${NODE8_ISOLATED_TEST_MODE:-false}" != true ]]; then
  [[ "$password_owner" == root:root && ( "$password_mode" == 600 || "$password_mode" == 400 ) ]] || fail 'RESTIC_PASSWORD_FILE must be root:root mode 0600/0400'
else
  [[ "$password_mode" == 600 || "$password_mode" == 400 ]] || fail 'RESTIC_PASSWORD_FILE must be mode 0600/0400 in isolated test mode'
fi

case "$RESTIC_REPOSITORY" in
  s3:*|rest:*|rclone:*|azure:*|gs:*|b2:*|sftp:*|swift:*) ;;
  *) [[ "$BACKUP_ALLOW_LOCAL_REPOSITORY" == true ]] || fail 'production backup repository must be off-host (set BACKUP_ALLOW_LOCAL_REPOSITORY=true only for isolated tests)' ;;
esac

db_exec() {
  if [[ -n "${NODE8_TEST_DATABASE_CONTAINER:-}" ]]; then
    [[ "${NODE8_ISOLATED_TEST_MODE:-false}" == true ]] || fail 'direct database container is permitted only in isolated test mode'
    docker exec -i "$NODE8_TEST_DATABASE_CONTAINER" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres "$@"
  fi
}

BACKUP_LOCK_FILE=${BACKUP_LOCK_FILE:-/run/lock/baykush-backup.lock}
mkdir -p "$(dirname "$BACKUP_LOCK_FILE")"
exec 9>"$BACKUP_LOCK_FILE"
flock -n 9 || fail 'another backup is already running'

mkdir -p "$BACKUP_STAGING_ROOT"
chmod 0700 "$BACKUP_STAGING_ROOT"
stage=$(mktemp -d "$BACKUP_STAGING_ROOT/run.XXXXXXXX")
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
pg_dump_version=$(db_exec pg_dump --version)
printf 'backup: creating consistent PostgreSQL custom-format dump\n'
db_exec \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --compress=6 --no-owner --no-acl > "$stage/baykush.dump"
[[ -s "$stage/baykush.dump" ]] || fail 'pg_dump produced an empty backup'

printf 'backup: recording migration ledger\n'
db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT filename || chr(9) || sha256 FROM node_schema_migrations ORDER BY filename' > "$stage/migrations.txt"
[[ -s "$stage/migrations.txt" ]] || fail 'migration ledger is empty'

database_metadata=$(db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT json_build_object(
    'databaseName', current_database(),
    'serverVersion', current_setting('server_version'),
    'migrationCount', (SELECT count(*) FROM node_schema_migrations),
    'rawRecordCount', (SELECT count(*) FROM raw_source_records),
    'canonicalRecordCount', (SELECT count(*) FROM canonical_evidence_records),
    'canonicalWithoutRawCount', (SELECT count(*) FROM canonical_evidence_records c LEFT JOIN raw_source_records r ON r.id=c.raw_record_id WHERE r.id IS NULL),
    'rawFingerprint', (SELECT md5(COALESCE(string_agg(id::text || ':' || payload_sha256, ',' ORDER BY id), '')) FROM raw_source_records),
    'canonicalFingerprint', (SELECT md5(COALESCE(string_agg(id::text || ':' || raw_record_id::text || ':' || canonical_key, ',' ORDER BY id), '')) FROM canonical_evidence_records)
  )")

dump_sha=$(sha256sum "$stage/baykush.dump" | awk '{print $1}')
migration_sha=$(sha256sum "$stage/migrations.txt" | awk '{print $1}')
dump_bytes=$(stat -c '%s' "$stage/baykush.dump")
node - "$stage/manifest.json" "$timestamp" "$dump_sha" "$migration_sha" "$dump_bytes" "$pg_dump_version" "$database_metadata" <<'NODE'
const fs = require('node:fs');
const [path, createdAt, dumpSha256, migrationLedgerSha256, dumpBytes, pgDumpVersion, metadataJson] = process.argv.slice(2);
const metadata = JSON.parse(metadataJson);
if (!metadata.databaseName || Number(metadata.migrationCount) < 1) throw new Error('invalid database backup metadata');
fs.writeFileSync(path, JSON.stringify({
  schemaVersion: 'NODE8_BACKUP_MANIFEST_V1',
  createdAt,
  database: { name: metadata.databaseName, serverVersion: metadata.serverVersion },
  databaseDump: 'baykush.dump',
  dumpFormat: 'postgresql-custom',
  pgDumpVersion,
  dumpBytes: Number(dumpBytes),
  dumpSha256,
  migrationLedger: 'migrations.txt',
  migrationLedgerSha256,
  migrationCount: Number(metadata.migrationCount),
  dataVerification: {
    fingerprintVersion: 'NODE8_DATA_FINGERPRINT_V1',
    rawRecordCount: Number(metadata.rawRecordCount),
    canonicalRecordCount: Number(metadata.canonicalRecordCount),
    canonicalWithoutRawCount: Number(metadata.canonicalWithoutRawCount),
    rawFingerprint: metadata.rawFingerprint,
    canonicalFingerprint: metadata.canonicalFingerprint,
  },
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
  --group-by host,paths,tags \
  --keep-last "${BACKUP_KEEP_LAST:-8}" \
  --keep-daily "${BACKUP_KEEP_DAILY:-7}" \
  --keep-weekly "${BACKUP_KEEP_WEEKLY:-4}" \
  --keep-monthly "${BACKUP_KEEP_MONTHLY:-6}" >/dev/null
if [[ "${BACKUP_RUN_PRUNE:-false}" == true ]]; then
  restic prune >/dev/null
fi

printf 'backup: PASS created_at=%s dump_sha256=%s\n' "$timestamp" "$dump_sha"

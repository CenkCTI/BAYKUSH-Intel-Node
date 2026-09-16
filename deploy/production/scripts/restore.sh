#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/baykush/backup.env}
RESTORE_SNAPSHOT=${RESTORE_SNAPSHOT:-latest}
RESTORE_DATABASE=${RESTORE_DATABASE:-baykush_restore_verify}
RESTORE_EVIDENCE_DIR=${RESTORE_EVIDENCE_DIR:-/var/lib/baykush/restore-evidence}

fail() { printf 'restore: %s\n' "$*" >&2; exit 1; }
if [[ ${EUID:-$(id -u)} -ne 0 && "${NODE8_ISOLATED_TEST_MODE:-false}" != true ]]; then
  fail 'must run as root on the production host'
fi
[[ "${NODE8_RESTORE_CONFIRM:-}" == YES ]] || fail 'set NODE8_RESTORE_CONFIRM=YES for an explicit restore operation'
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
BACKUP_ALLOW_LOCAL_REPOSITORY=${BACKUP_ALLOW_LOCAL_REPOSITORY:-false}
for command in docker restic sha256sum node find mktemp stat; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done
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
  *) [[ "$BACKUP_ALLOW_LOCAL_REPOSITORY" == true ]] || fail 'production restore repository must be off-host (set BACKUP_ALLOW_LOCAL_REPOSITORY=true only for isolated tests)' ;;
esac

db_exec() {
  if [[ -n "${NODE8_TEST_DATABASE_CONTAINER:-}" ]]; then
    [[ "${NODE8_ISOLATED_TEST_MODE:-false}" == true ]] || fail 'direct database container is permitted only in isolated test mode'
    docker exec -i "$NODE8_TEST_DATABASE_CONTAINER" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres "$@"
  fi
}

if [[ "$RESTORE_DATABASE" == "$POSTGRES_DB" && "${NODE8_RESTORE_PRODUCTION_CONFIRM:-}" != YES ]]; then
  fail 'refusing to overwrite the production database without NODE8_RESTORE_PRODUCTION_CONFIRM=YES'
fi
case "$RESTORE_DATABASE" in
  postgres|template0|template1) fail 'refusing unsafe restore database name' ;;
esac
if [[ "$RESTORE_DATABASE" != baykush_restore_* && "${NODE8_RESTORE_PRODUCTION_CONFIRM:-}" != YES ]]; then
  fail 'isolated restore database must use the baykush_restore_ prefix'
fi

stage=$(mktemp -d /tmp/baykush-restore.XXXXXXXX)
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

printf 'restore: retrieving encrypted snapshot %s\n' "$RESTORE_SNAPSHOT"
restic restore "$RESTORE_SNAPSHOT" --tag baykush-node --target "$stage" >/dev/null

mapfile -t dumps < <(find "$stage" -type f -name baykush.dump -print)
mapfile -t manifests < <(find "$stage" -type f -name manifest.json -print)
mapfile -t ledgers < <(find "$stage" -type f -name migrations.txt -print)
[[ ${#dumps[@]} -eq 1 && -s "${dumps[0]}" ]] || fail 'restored snapshot must contain exactly one non-empty baykush.dump'
[[ ${#manifests[@]} -eq 1 && -s "${manifests[0]}" ]] || fail 'restored snapshot must contain exactly one non-empty manifest.json'
[[ ${#ledgers[@]} -eq 1 && -s "${ledgers[0]}" ]] || fail 'restored snapshot must contain exactly one non-empty migrations.txt'
dump=${dumps[0]}; manifest=${manifests[0]}; migrations=${ledgers[0]}

node - "$manifest" "$dump" "$migrations" "$POSTGRES_DB" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [manifestPath, dumpPath, migrationsPath, expectedDatabase] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 'NODE8_BACKUP_MANIFEST_V1') throw new Error('unsupported backup manifest');
if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(manifest.createdAt)) throw new Error('invalid backup creation timestamp');
if (manifest.databaseDump !== 'baykush.dump' || manifest.migrationLedger !== 'migrations.txt') throw new Error('invalid manifest artifact identity');
if (manifest.dumpFormat !== 'postgresql-custom' || !manifest.pgDumpVersion) throw new Error('unsupported database dump format');
if (!manifest.database?.name || !manifest.database?.serverVersion) throw new Error('missing database identity');
if (manifest.database.name !== expectedDatabase) throw new Error('backup database identity does not match configured database');
if (!Number.isSafeInteger(manifest.dumpBytes) || manifest.dumpBytes < 1 || fs.statSync(dumpPath).size !== manifest.dumpBytes) throw new Error('database dump size mismatch');
if (!Number.isSafeInteger(manifest.migrationCount) || manifest.migrationCount < 1) throw new Error('missing migration-ledger metadata');
const verification = manifest.dataVerification;
if (verification?.fingerprintVersion !== 'NODE8_DATA_FINGERPRINT_V1') throw new Error('missing data verification metadata');
for (const key of ['rawRecordCount', 'canonicalRecordCount', 'canonicalWithoutRawCount']) {
  if (!Number.isSafeInteger(verification[key]) || verification[key] < 0) throw new Error(`invalid ${key}`);
}
for (const key of ['rawFingerprint', 'canonicalFingerprint']) {
  if (!/^[a-f0-9]{32}$/.test(verification[key])) throw new Error(`invalid ${key}`);
}
const sha = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
if (sha(dumpPath) !== manifest.dumpSha256) throw new Error('database dump checksum mismatch');
if (sha(migrationsPath) !== manifest.migrationLedgerSha256) throw new Error('migration ledger checksum mismatch');
if (manifest.includesSecrets !== false) throw new Error('backup manifest does not assert secret exclusion');
NODE

db_exec \
  pg_restore --list < "$dump" >/dev/null || fail 'database dump is not a readable PostgreSQL custom-format archive'

printf 'restore: recreating isolated target database %s\n' "$RESTORE_DATABASE"
db_exec \
  dropdb -U "$POSTGRES_USER" --if-exists "$RESTORE_DATABASE"
db_exec \
  createdb -U "$POSTGRES_USER" "$RESTORE_DATABASE"
db_exec \
  pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" --no-owner --no-acl < "$dump"

migration_count=$(db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT count(*) FROM node_schema_migrations')
raw_count=$(db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT count(*) FROM raw_source_records')
canonical_count=$(db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT count(*) FROM canonical_evidence_records')

restored_ledger="$stage/restored-migrations.txt"
db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT filename || chr(9) || sha256 FROM node_schema_migrations ORDER BY filename' > "$restored_ledger"
[[ "$(sha256sum "$restored_ledger" | awk '{print $1}')" == "$(sha256sum "$migrations" | awk '{print $1}')" ]] || fail 'restored migration ledger does not match backup ledger'

restored_metadata=$(db_exec \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" -c \
  "SELECT json_build_object(
    'migrationCount', (SELECT count(*) FROM node_schema_migrations),
    'rawRecordCount', (SELECT count(*) FROM raw_source_records),
    'canonicalRecordCount', (SELECT count(*) FROM canonical_evidence_records),
    'canonicalWithoutRawCount', (SELECT count(*) FROM canonical_evidence_records c LEFT JOIN raw_source_records r ON r.id=c.raw_record_id WHERE r.id IS NULL),
    'rawFingerprint', (SELECT md5(COALESCE(string_agg(id::text || ':' || payload_sha256, ',' ORDER BY id), '')) FROM raw_source_records),
    'canonicalFingerprint', (SELECT md5(COALESCE(string_agg(id::text || ':' || raw_record_id::text || ':' || canonical_key, ',' ORDER BY id), '')) FROM canonical_evidence_records),
    'immutableTriggerCount', (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('raw_source_records_immutable_update','canonical_evidence_immutable_update'))
  )")

mkdir -p "$RESTORE_EVIDENCE_DIR"
chmod 0700 "$RESTORE_EVIDENCE_DIR"
evidence="$RESTORE_EVIDENCE_DIR/restore-$(date -u +%Y%m%dT%H%M%SZ).json"
node - "$manifest" "$restored_metadata" "$evidence" "$RESTORE_SNAPSHOT" "$RESTORE_DATABASE" "$migration_count" "$raw_count" "$canonical_count" <<'NODE'
const fs = require('node:fs');
const [manifestPath, restoredJson, path, snapshot, database, migrations, raw, canonical] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const restored = JSON.parse(restoredJson);
const expected = manifest.dataVerification;
for (const key of ['rawRecordCount', 'canonicalRecordCount', 'canonicalWithoutRawCount', 'rawFingerprint', 'canonicalFingerprint']) {
  if (restored[key] !== expected[key]) throw new Error(`restored ${key} does not match backup manifest`);
}
if (Number(migrations) !== manifest.migrationCount || Number(migrations) < 1) throw new Error('restored migration count does not match manifest');
if (restored.canonicalWithoutRawCount !== 0) throw new Error('restored canonical provenance is incomplete');
if (Number(restored.immutableTriggerCount) !== 2) throw new Error('required immutable revision triggers are missing');
fs.writeFileSync(path, JSON.stringify({
  schemaVersion: 'NODE8_RESTORE_ACCEPTANCE_V1',
  accepted: true,
  verifiedAt: new Date().toISOString(),
  snapshot,
  restoreDatabase: database,
  migrationCount: Number(migrations),
  rawRecordCount: Number(raw),
  canonicalRecordCount: Number(canonical),
  checksumVerified: true,
  databaseIdentityVerified: true,
  migrationLedgerVerified: true,
  dataFingerprintsVerified: true,
  provenanceVerified: true,
  immutableRevisionGuardsVerified: true,
}, null, 2) + '\n', { mode: 0o600 });
NODE
chmod 0600 "$evidence"

printf 'restore: PASS evidence=%s\n' "$evidence"

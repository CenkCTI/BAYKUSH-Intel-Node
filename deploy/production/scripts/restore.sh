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
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root on the production host'
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
for command in docker restic sha256sum node find mktemp; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done

if [[ "$RESTORE_DATABASE" == "$POSTGRES_DB" && "${NODE8_RESTORE_PRODUCTION_CONFIRM:-}" != YES ]]; then
  fail 'refusing to overwrite the production database without NODE8_RESTORE_PRODUCTION_CONFIRM=YES'
fi

stage=$(mktemp -d /tmp/baykush-restore.XXXXXXXX)
cleanup() { rm -rf "$stage"; }
trap cleanup EXIT

printf 'restore: retrieving encrypted snapshot %s\n' "$RESTORE_SNAPSHOT"
restic restore "$RESTORE_SNAPSHOT" --tag baykush-node --target "$stage" >/dev/null

dump=$(find "$stage" -type f -name baykush.dump -print -quit)
manifest=$(find "$stage" -type f -name manifest.json -print -quit)
migrations=$(find "$stage" -type f -name migrations.txt -print -quit)
[[ -n "$dump" && -s "$dump" ]] || fail 'restored snapshot is missing baykush.dump'
[[ -n "$manifest" && -s "$manifest" ]] || fail 'restored snapshot is missing manifest.json'
[[ -n "$migrations" && -f "$migrations" ]] || fail 'restored snapshot is missing migrations.txt'

node - "$manifest" "$dump" "$migrations" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [manifestPath, dumpPath, migrationsPath] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.schemaVersion !== 'NODE8_BACKUP_MANIFEST_V1') throw new Error('unsupported backup manifest');
const sha = (path) => crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
if (sha(dumpPath) !== manifest.dumpSha256) throw new Error('database dump checksum mismatch');
if (sha(migrationsPath) !== manifest.migrationLedgerSha256) throw new Error('migration ledger checksum mismatch');
if (manifest.includesSecrets !== false) throw new Error('backup manifest does not assert secret exclusion');
NODE

printf 'restore: recreating isolated target database %s\n' "$RESTORE_DATABASE"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  dropdb -U "$POSTGRES_USER" --if-exists "$RESTORE_DATABASE"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  createdb -U "$POSTGRES_USER" "$RESTORE_DATABASE"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  pg_restore -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" --no-owner --no-acl < "$dump"

migration_count=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT count(*) FROM node_schema_migrations')
raw_count=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT count(*) FROM raw_source_records')
canonical_count=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$RESTORE_DATABASE" \
  -c 'SELECT count(*) FROM canonical_evidence_records')

mkdir -p "$RESTORE_EVIDENCE_DIR"
chmod 0700 "$RESTORE_EVIDENCE_DIR"
evidence="$RESTORE_EVIDENCE_DIR/restore-$(date -u +%Y%m%dT%H%M%SZ).json"
node - "$evidence" "$RESTORE_SNAPSHOT" "$RESTORE_DATABASE" "$migration_count" "$raw_count" "$canonical_count" <<'NODE'
const fs = require('node:fs');
const [path, snapshot, database, migrations, raw, canonical] = process.argv.slice(2);
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
}, null, 2) + '\n', { mode: 0o600 });
NODE
chmod 0600 "$evidence"

printf 'restore: PASS evidence=%s\n' "$evidence"

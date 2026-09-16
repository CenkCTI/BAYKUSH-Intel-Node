#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/baykush/backup.env}
OPS_EVIDENCE_DIR=${OPS_EVIDENCE_DIR:-/var/lib/baykush/ops-evidence}
DISK_PATH=${DISK_PATH:-/var/lib/docker}
DISK_WARN_PERCENT=${DISK_WARN_PERCENT:-80}
DISK_CRITICAL_PERCENT=${DISK_CRITICAL_PERCENT:-90}
BACKUP_MAX_AGE_HOURS=${BACKUP_MAX_AGE_HOURS:-8}

fail() { printf 'ops-snapshot: %s\n' "$*" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
if [[ -f "$BACKUP_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$BACKUP_ENV_FILE"
fi
set +a

for command in docker df node mktemp; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done

tmp=$(mktemp -d /tmp/baykush-ops.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format json > "$tmp/containers.json"; then
  printf 'ok\n' > "$tmp/containers.status"
else
  printf 'failed\n' > "$tmp/containers.status"
  : > "$tmp/containers.json"
fi
if [[ -e "$DISK_PATH" ]]; then
  if df -P "$DISK_PATH" 2>/dev/null | tail -n1 > "$tmp/disk.txt"; then
    printf 'ok\n' > "$tmp/disk.status"
  else
    printf 'failed\n' > "$tmp/disk.status"
    : > "$tmp/disk.txt"
  fi
elif [[ "$DISK_PATH" == "/var/lib/docker" ]] && df -P / 2>/dev/null | tail -n1 > "$tmp/disk.txt"; then
  printf 'ok\n' > "$tmp/disk.status"
else
  printf 'failed\n' > "$tmp/disk.status"
  : > "$tmp/disk.txt"
fi

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node -e "fetch('http://127.0.0.1:8080/v1/health').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" \
  > "$tmp/api-health.json" 2>/dev/null; then
  printf 'ok\n' > "$tmp/api.status"
else
  printf 'failed\n' > "$tmp/api.status"
  printf '%s\n' '{"status":"unreachable"}' > "$tmp/api-health.json"
fi

if command -v restic >/dev/null 2>&1 && [[ -n "${RESTIC_REPOSITORY:-}" && -n "${RESTIC_PASSWORD_FILE:-}" ]]; then
  if restic snapshots --latest 1 --tag baykush-node --json > "$tmp/backups.json" 2>/dev/null; then
    printf 'ok\n' > "$tmp/backups.status"
  else
    printf 'failed\n' > "$tmp/backups.status"
    printf '%s\n' '[]' > "$tmp/backups.json"
  fi
else
  printf 'unavailable\n' > "$tmp/backups.status"
  printf '%s\n' '[]' > "$tmp/backups.json"
fi

mkdir -p "$OPS_EVIDENCE_DIR"
chmod 0700 "$OPS_EVIDENCE_DIR"
out="$OPS_EVIDENCE_DIR/ops-$(date -u +%Y%m%dT%H%M%SZ).json"

node "$(dirname "$0")/node8-ops-snapshot-evidence.mjs" \
  "$tmp/containers.json" "$tmp/containers.status" "$tmp/disk.txt" "$tmp/disk.status" \
  "$tmp/api-health.json" "$tmp/api.status" "$tmp/backups.json" "$tmp/backups.status" \
  "$out" "$DISK_WARN_PERCENT" "$DISK_CRITICAL_PERCENT" "$BACKUP_MAX_AGE_HOURS"

printf 'ops-snapshot: evidence=%s\n' "$out" >&2

#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
BACKUP_ENV_FILE=${BACKUP_ENV_FILE:-/etc/baykush/backup.env}
OPS_EVIDENCE_DIR=${OPS_EVIDENCE_DIR:-/var/lib/baykush/ops-evidence}
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

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format json > "$tmp/containers.json" || true
df -P /var/lib/docker 2>/dev/null | tail -n1 > "$tmp/disk.txt" || df -P / | tail -n1 > "$tmp/disk.txt"

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
  node -e "fetch('http://127.0.0.1:8080/v1/health').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" \
  > "$tmp/api-health.json" 2>/dev/null; then
  :
else
  printf '%s\n' '{"status":"unreachable"}' > "$tmp/api-health.json"
fi

if command -v restic >/dev/null 2>&1 && [[ -n "${RESTIC_REPOSITORY:-}" && -n "${RESTIC_PASSWORD_FILE:-}" ]]; then
  restic snapshots --latest 1 --tag baykush-node --json > "$tmp/backups.json" 2>/dev/null || printf '%s\n' '[]' > "$tmp/backups.json"
else
  printf '%s\n' '[]' > "$tmp/backups.json"
fi

mkdir -p "$OPS_EVIDENCE_DIR"
chmod 0700 "$OPS_EVIDENCE_DIR"
out="$OPS_EVIDENCE_DIR/ops-$(date -u +%Y%m%dT%H%M%SZ).json"

node - "$tmp/containers.json" "$tmp/disk.txt" "$tmp/api-health.json" "$tmp/backups.json" "$out" "$DISK_WARN_PERCENT" "$DISK_CRITICAL_PERCENT" "$BACKUP_MAX_AGE_HOURS" <<'NODE'
const fs = require('node:fs');
const [containersPath, diskPath, apiPath, backupPath, out, warnRaw, criticalRaw, backupMaxRaw] = process.argv.slice(2);
const parseJsonLoose = (text) => {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try { const parsed = JSON.parse(trimmed); return Array.isArray(parsed) ? parsed : [parsed]; }
  catch { return trimmed.split(/\n+/).filter(Boolean).map((line) => JSON.parse(line)); }
};
const containers = parseJsonLoose(fs.readFileSync(containersPath, 'utf8'));
const diskFields = fs.readFileSync(diskPath, 'utf8').trim().split(/\s+/);
const diskPercent = Number((diskFields[4] ?? '0%').replace('%', ''));
let api;
try { api = JSON.parse(fs.readFileSync(apiPath, 'utf8')); } catch { api = { status: 'unparseable' }; }
const backups = parseJsonLoose(fs.readFileSync(backupPath, 'utf8'));
const latest = backups[0] ?? null;
const backupAgeHours = latest?.time ? (Date.now() - Date.parse(latest.time)) / 3_600_000 : null;
const warn = Number(warnRaw), critical = Number(criticalRaw), backupMax = Number(backupMaxRaw);
const unhealthyContainers = containers.filter((item) => {
  const state = String(item.State ?? item.state ?? '').toLowerCase();
  const health = String(item.Health ?? item.health ?? '').toLowerCase();
  return state && state !== 'running' || health === 'unhealthy';
}).map((item) => item.Service ?? item.Name ?? item.name ?? 'unknown');
const problems = [];
if (diskPercent >= critical) problems.push({ class: 'DISK_CRITICAL', diskPercent });
else if (diskPercent >= warn) problems.push({ class: 'DISK_WARNING', diskPercent });
if (api?.data?.status !== 'ok' && api?.status !== 'ok') problems.push({ class: 'API_UNHEALTHY' });
if (unhealthyContainers.length) problems.push({ class: 'CONTAINER_UNHEALTHY', services: unhealthyContainers });
if (backupAgeHours === null) problems.push({ class: 'BACKUP_UNKNOWN' });
else if (backupAgeHours > backupMax) problems.push({ class: 'BACKUP_STALE', backupAgeHours });
const evidence = {
  schemaVersion: 'NODE8_OPS_SNAPSHOT_V1',
  observedAt: new Date().toISOString(),
  status: problems.some((p) => p.class === 'DISK_CRITICAL' || p.class === 'API_UNHEALTHY' || p.class === 'CONTAINER_UNHEALTHY') ? 'CRITICAL' : problems.length ? 'DEGRADED' : 'HEALTHY',
  disk: { usedPercent: diskPercent, warningPercent: warn, criticalPercent: critical },
  api: { reachable: !problems.some((p) => p.class === 'API_UNHEALTHY') },
  containers: { count: containers.length, unhealthy: unhealthyContainers },
  backup: { latestAt: latest?.time ?? null, ageHours: backupAgeHours, maxAgeHours: backupMax },
  problems,
  containsSecrets: false,
};
fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
NODE

printf 'ops-snapshot: evidence=%s\n' "$out" >&2

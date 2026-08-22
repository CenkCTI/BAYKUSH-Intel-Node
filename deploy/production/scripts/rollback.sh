#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
RELEASE_DIR=${RELEASE_DIR:-/var/lib/baykush/releases}
SET_IMAGE_SCRIPT=${SET_IMAGE_SCRIPT:-/opt/baykush-node/scripts/set-release-image.sh}
BACKUP_SCRIPT=${BACKUP_SCRIPT:-/opt/baykush-node/scripts/backup.sh}
SMOKE_SCRIPT=${SMOKE_SCRIPT:-/opt/baykush-node/scripts/smoke-test.sh}
RUNTIME_AUDIT_SCRIPT=${RUNTIME_AUDIT_SCRIPT:-/opt/baykush-node/scripts/runtime-audit.sh}
NETWORK_AUDIT_SCRIPT=${NETWORK_AUDIT_SCRIPT:-/opt/baykush-node/scripts/network-audit.sh}
RELEASE_EVIDENCE_SCRIPT=${RELEASE_EVIDENCE_SCRIPT:-/opt/baykush-node/scripts/release-evidence.sh}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/run/lock/baykush-node-deploy.lock}

fail() { printf 'rollback: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root'
[[ "${NODE8_ROLLBACK_CONFIRM:-}" == YES ]] || fail 'set NODE8_ROLLBACK_CONFIRM=YES'
[[ "${NODE8_ROLLBACK_SCHEMA_COMPATIBLE:-}" == YES ]] || fail 'confirm previous application release is compatible with the current forward-only schema using NODE8_ROLLBACK_SCHEMA_COMPATIBLE=YES'
[[ -f "$RELEASE_DIR/current.json" ]] || fail 'current release evidence is missing'

exec 9>"$DEPLOY_LOCK_FILE"
flock -n 9 || fail 'another deployment/rollback is already running'

current_image=$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.image??"")' "$RELEASE_DIR/current.json")
previous_image=$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.previousImage??"")' "$RELEASE_DIR/current.json")
[[ "$current_image" =~ @sha256:[0-9a-f]{64}$ ]] || fail 'current release evidence has no valid digest image'
[[ "$previous_image" =~ @sha256:[0-9a-f]{64}$ ]] || fail 'no previous digest-pinned release is available'
[[ "$previous_image" != "$current_image" ]] || fail 'previous and current image are identical'

printf 'rollback: preserving current database state before application rollback\n'
bash "$BACKUP_SCRIPT"

printf 'rollback: switching application image only; database schema is NOT rolled back\n'
bash "$SET_IMAGE_SCRIPT" "$previous_image"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans

for attempt in $(seq 1 30); do
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
    node -e "fetch('http://127.0.0.1:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  [[ "$attempt" != 30 ]] || fail 'rolled-back API did not become healthy; operator recovery required'
  sleep 2
done

bash "$SMOKE_SCRIPT"
bash "$RUNTIME_AUDIT_SCRIPT"
bash "$NETWORK_AUDIT_SCRIPT"
BACKUP_GATE_PASSED=true bash "$RELEASE_EVIDENCE_SCRIPT"
printf 'rollback: PASS from=%s to=%s schema=unchanged\n' "$current_image" "$previous_image"

#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
SMOKE_SCRIPT=${SMOKE_SCRIPT:-/opt/baykush-node/scripts/smoke-test.sh}
PREFLIGHT_SCRIPT=${PREFLIGHT_SCRIPT:-/opt/baykush-node/scripts/preflight.sh}
DB_ROLE_SCRIPT=${DB_ROLE_SCRIPT:-/opt/baykush-node/scripts/provision-db-roles.sh}
BACKUP_SCRIPT=${BACKUP_SCRIPT:-/opt/baykush-node/scripts/backup.sh}
RUNTIME_AUDIT_SCRIPT=${RUNTIME_AUDIT_SCRIPT:-/opt/baykush-node/scripts/runtime-audit.sh}
NETWORK_AUDIT_SCRIPT=${NETWORK_AUDIT_SCRIPT:-/opt/baykush-node/scripts/network-audit.sh}
RELEASE_EVIDENCE_SCRIPT=${RELEASE_EVIDENCE_SCRIPT:-/opt/baykush-node/scripts/release-evidence.sh}
DEPLOY_LOCK_FILE=${DEPLOY_LOCK_FILE:-/run/lock/baykush-node-deploy.lock}

fail() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root on the production host'
command -v flock >/dev/null 2>&1 || fail 'flock is required'

exec 9>"$DEPLOY_LOCK_FILE"
flock -n 9 || fail 'another BAYKUSH deployment is already running'

bash "$PREFLIGHT_SCRIPT"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${BAYKUSH_NODE_IMAGE:?BAYKUSH_NODE_IMAGE is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
POSTGRES_DB=${POSTGRES_DB:-baykush}
[[ "$BAYKUSH_NODE_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || fail 'production deploy requires a digest-pinned image'

backup_gate=false
postgres_container=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)
if [[ -n "$postgres_container" ]]; then
  durable=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
    psql -X -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT to_regclass('public.node_schema_migrations') IS NOT NULL" 2>/dev/null || true)
  if [[ "$durable" == t ]]; then
    printf 'deploy: durable database detected; enforcing pre-migration encrypted backup gate\n'
    bash "$BACKUP_SCRIPT"
    backup_gate=true
  fi
fi

printf 'deploy: pulling exact release images\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull

printf 'deploy: starting PostgreSQL\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres

printf 'deploy: running one-shot forward migration gate with migration-only credential\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm migrate

printf 'deploy: provisioning/rotating least-privilege runtime database logins\n'
bash "$DB_ROLE_SCRIPT"

printf 'deploy: starting runtime services\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans

printf 'deploy: waiting for API health\n'
for attempt in $(seq 1 30); do
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T api \
    node -e "fetch('http://127.0.0.1:8080/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  if [[ "$attempt" == "30" ]]; then
    printf 'deploy: API did not become healthy\n' >&2
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps >&2 || true
    exit 1
  fi
  sleep 2
done

printf 'deploy: running authenticated/application smoke\n'
bash "$SMOKE_SCRIPT"
printf 'deploy: auditing runtime and network boundary\n'
bash "$RUNTIME_AUDIT_SCRIPT"
bash "$NETWORK_AUDIT_SCRIPT"

BACKUP_GATE_PASSED="$backup_gate" bash "$RELEASE_EVIDENCE_SCRIPT"
printf 'deploy: PASS image=%s\n' "$BAYKUSH_NODE_IMAGE"

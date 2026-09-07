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
BACKUP_GATE_DIR=${BACKUP_GATE_DIR:-/var/lib/baykush/backup-gates}

fail() { printf 'deploy: %s\n' "$*" >&2; exit 1; }
if [[ ${EUID:-$(id -u)} -ne 0 && "${NODE8_ISOLATED_TEST_MODE:-false}" != true ]]; then
  fail 'must run as root on the production host'
fi
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
[[ "$BAYKUSH_NODE_IMAGE" =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] || fail 'production deploy requires a digest-pinned image'

backup_gate=false
durable=false
postgres_container=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q postgres 2>/dev/null || true)
if [[ -n "$postgres_container" ]]; then
  durable_probe=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
    psql -X -A -t -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -c "SELECT to_regclass('public.node_schema_migrations') IS NOT NULL" 2>/dev/null) \
    || fail 'cannot determine whether the running database contains durable state'
  case "$durable_probe" in t) durable=true ;; f) durable=false ;; *) fail 'database durable-state probe returned an invalid result' ;; esac
else
  project_name=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s);process.stdout.write(c.name||"")})')
  [[ -n "$project_name" ]] || fail 'cannot determine Compose project name for durable-state detection'
  if docker volume inspect "${project_name}_baykush_pgdata" >/dev/null 2>&1; then durable=true; fi
fi

printf 'deploy: pulling exact release images\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull

printf 'deploy: starting PostgreSQL\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres

if [[ "$durable" == true ]]; then
  printf 'deploy: durable database detected; enforcing pre-migration encrypted backup gate\n'
  mkdir -p "$BACKUP_GATE_DIR"
  chmod 0700 "$BACKUP_GATE_DIR"
  backup_evidence=$(mktemp "$BACKUP_GATE_DIR/gate.XXXXXXXX.json")
  rm -f "$backup_evidence"
  BACKUP_EVIDENCE_OUT="$backup_evidence" bash "$BACKUP_SCRIPT"
  [[ -f "$backup_evidence" ]] || fail 'backup completed without durability evidence'
  node -e '
const fs=require("fs");const e=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
if(e.schemaVersion!=="NODE8_BACKUP_GATE_EVIDENCE_V1"||e.durable!==true||
 !/^[0-9a-f]{8,64}$/i.test(e.snapshotId||"")||!/^[0-9a-f]{64}$/.test(e.dumpSha256||"")||
 !/^[0-9a-f]{64}$/.test(e.migrationLedgerSha256||"")||!Number.isFinite(Date.parse(e.createdAt))) process.exit(1)
' "$backup_evidence" || fail 'backup durability evidence is invalid'
  rm -f "$backup_evidence"
  backup_gate=true
fi

printf 'deploy: running one-shot forward migration gate with migration-only credential\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm migrate

printf 'deploy: provisioning least-privilege runtime database logins\n'
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

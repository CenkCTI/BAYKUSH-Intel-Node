#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
FAULT_MATRIX=${FAULT_MATRIX:-/opt/baykush-node/acceptance/fault-matrix.json}
ACCEPTANCE_DIR=${ACCEPTANCE_DIR:-/var/lib/baykush/acceptance}
FAULT_LEVEL=${NODE8_FAULT_LEVEL:-SAFE}

fail() { printf 'fault-acceptance: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root on the production host'
[[ "${NODE8_FAULT_ACCEPTANCE_CONFIRM:-}" == YES ]] || fail 'set NODE8_FAULT_ACCEPTANCE_CONFIRM=YES before intentionally restarting services'
[[ "$FAULT_LEVEL" == SAFE || "$FAULT_LEVEL" == FULL ]] || fail 'NODE8_FAULT_LEVEL must be SAFE or FULL'
[[ -f "$FAULT_MATRIX" ]] || fail "fault matrix not found: $FAULT_MATRIX"
for command in docker node curl; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

mkdir -p "$ACCEPTANCE_DIR"
chmod 0700 "$ACCEPTANCE_DIR"
results=$(mktemp)
trap 'rm -f "$results"' EXIT
printf '%s\n' '[]' > "$results"

append_result() {
  local id=$1 status=$2 detail=$3
  node - "$results" "$id" "$status" "$detail" <<'NODE'
const fs=require('node:fs');
const [path,id,status,detail]=process.argv.slice(2);
const list=JSON.parse(fs.readFileSync(path,'utf8'));
list.push({id,status,detail,observedAt:new Date().toISOString()});
fs.writeFileSync(path,JSON.stringify(list,null,2)+'\n');
NODE
}

wait_api() {
  for attempt in $(seq 1 60); do
    if curl --fail --silent --show-error --max-time 5 "https://${NODE_HOSTNAME}/v1/health" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

run_restart() {
  local id=$1 service=$2
  printf 'fault-acceptance: restarting %s for %s\n' "$service" "$id"
  if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" restart "$service" >/dev/null && wait_api; then
    append_result "$id" PASS "service restart recovered and API returned healthy"
  else
    append_result "$id" FAIL "service restart did not recover within bounded health window"
    return 1
  fi
}

# SAFE mode intentionally limits itself to reversible service restarts. FULL is
# still not permission to simulate VM/network/disk destruction automatically;
# those scenarios remain manual real-host evidence by design.
run_restart POSTGRES_RESTART postgres
run_restart WORKER_CRASH worker
run_restart DISCOVERY_CRASH discovery
run_restart STREAM_WORKER_CRASH stream-worker
run_restart CADDY_RESTART caddy

bad_status=$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  -H 'Authorization: Bearer deliberately-invalid-node8-credential' \
  "https://${NODE_HOSTNAME}/v1/sources" || true)
if [[ "$bad_status" == 401 ]]; then append_result BAD_API_CREDENTIAL PASS 'invalid service credential rejected with 401';
else append_result BAD_API_CREDENTIAL FAIL "expected 401, got $bad_status"; fi

manual_count=$(node - "$FAULT_MATRIX" <<'NODE'
const fs=require('node:fs');const m=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(String(m.scenarios.filter(s=>s.executionMode==='MANUAL_REAL_HOST').length));
NODE
)
failed=$(node - "$results" <<'NODE'
const fs=require('node:fs');const r=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
process.stdout.write(String(r.filter(x=>x.status==='FAIL').length));
NODE
)
out="$ACCEPTANCE_DIR/fault-$(date -u +%Y%m%dT%H%M%SZ).json"
node - "$results" "$FAULT_MATRIX" "$out" "$manual_count" "$failed" "$FAULT_LEVEL" <<'NODE'
const fs=require('node:fs');
const [resultsPath,matrixPath,out,manualCount,failed,level]=process.argv.slice(2);
const evidence={
  schemaVersion:'NODE8_FAULT_ACCEPTANCE_V1',
  observedAt:new Date().toISOString(),
  level,
  automatedAccepted:Number(failed)===0,
  fullyAccepted:false,
  manualRealHostScenariosPending:Number(manualCount),
  results:JSON.parse(fs.readFileSync(resultsPath,'utf8')),
  faultMatrixSha256:null,
  containsSecrets:false,
  note:'Manual real-host scenarios must be recorded separately before final NODE-8 acceptance.'
};
fs.writeFileSync(out,JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
NODE
chmod 0600 "$out"
[[ "$failed" == 0 ]] || fail "one or more automated safe fault scenarios failed; evidence=$out"
printf 'fault-acceptance: SAFE PASS; manual_real_host_pending=%s evidence=%s\n' "$manual_count" "$out"

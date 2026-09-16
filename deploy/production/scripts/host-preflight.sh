#!/usr/bin/env bash
set -u -o pipefail
umask 077
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
INSTALL_DIR=${INSTALL_DIR:-/opt/baykush-node}
STATE_DIR=${STATE_DIR:-/var/lib/baykush}
SECRET_DIR=${BAYKUSH_SECRET_DIR:-/etc/baykush/secrets}
MIN_DISK_GIB=${NODE8J_MIN_DISK_GIB:-20}
results=$(mktemp); trap 'rm -f "$results"' EXIT
: > "$results"
add() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$results"; }
command -v uname >/dev/null && [[ $(uname -s) == Linux ]] && add LINUX PASS Linux || add LINUX FAIL 'Linux is required'
if [[ -r /etc/os-release ]]; then . /etc/os-release; [[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] && add OS PASS 'Ubuntu 24.04 LTS' || add OS MANUAL_REVIEW "supported target is Ubuntu 24.04 LTS; detected ${ID:-unknown} ${VERSION_ID:-unknown}"; else add OS FAIL '/etc/os-release unavailable'; fi
[[ $(uname -m) == x86_64 ]] && add ARCH PASS x86_64 || add ARCH FAIL 'x86_64/amd64 is required'
if [[ ${EUID:-$(id -u)} -eq 0 ]] || { command -v sudo >/dev/null && sudo -n true >/dev/null 2>&1; }; then add PRIVILEGE PASS 'root or noninteractive sudo available'; else add PRIVILEGE MANUAL_REVIEW 'privileged installation steps require root/sudo'; fi
command -v node >/dev/null && add NODE PASS installed || add NODE FAIL missing
command -v docker >/dev/null && add DOCKER PASS installed || add DOCKER FAIL missing
docker compose version >/dev/null 2>&1 && add COMPOSE PASS available || add COMPOSE FAIL unavailable
[[ -d /run/systemd/system ]] && command -v systemctl >/dev/null && add SYSTEMD PASS available || add SYSTEMD FAIL unavailable
if command -v timedatectl >/dev/null; then sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || true); [[ $sync == yes ]] && add TIME_SYNC PASS synchronized || add TIME_SYNC MANUAL_REVIEW 'NTP synchronization is not currently confirmed'; else add TIME_SYNC MANUAL_REVIEW 'timedatectl unavailable'; fi
if [[ $MIN_DISK_GIB =~ ^[0-9]+$ ]] && (( MIN_DISK_GIB > 0 )); then avail=$(df -Pk "$(dirname "$STATE_DIR")" 2>/dev/null | awk 'NR==2{print int($4/1048576)}'); [[ ${avail:-0} -ge $MIN_DISK_GIB ]] && add DISK PASS "${avail}GiB available (minimum ${MIN_DISK_GIB}GiB)" || add DISK FAIL "${avail:-0}GiB available; minimum ${MIN_DISK_GIB}GiB"; else add DISK FAIL 'NODE8J_MIN_DISK_GIB must be a positive integer'; fi
for spec in "INSTALL_DIR:$INSTALL_DIR" "STATE_DIR:$STATE_DIR" "SECRET_DIR:$SECRET_DIR"; do id=${spec%%:*}; path=${spec#*:}; if [[ -d $path ]]; then [[ -w $path || ${EUID:-1} -eq 0 ]] && add "$id" PASS 'directory exists and can be administered' || add "$id" MANUAL_REVIEW 'directory exists; privileged ownership enforcement required'; else parent=$(dirname "$path"); [[ -d $parent && ( -w $parent || ${EUID:-1} -eq 0 ) ]] && add "$id" PASS 'documented install process can create directory' || add "$id" MANUAL_REVIEW 'privileged install process must create directory'; fi; done
if command -v ss >/dev/null; then
  listeners=$(ss -H -lnt 2>/dev/null || true)
  for port in 80 443; do if awk -v p=":$port" '$4 ~ p"$"{found=1} END{exit !found}' <<<"$listeners"; then add "PORT_$port" MANUAL_REVIEW "port $port already has a listener; confirm it is production Caddy"; else add "PORT_$port" PASS "port $port available"; fi; done
  for port in 5432 8080; do if awk -v p=":$port" '$4 ~ /^(0\.0\.0\.0|\*|\[::\]|::):/ && $4 ~ p"$"{found=1} END{exit !found}' <<<"$listeners"; then add "NO_PUBLIC_$port" FAIL "public listener detected on $port"; else add "NO_PUBLIC_$port" PASS "no public listener on $port"; fi; done
else add PORTS MANUAL_REVIEW 'ss unavailable; listener state requires review'; fi
[[ -d $SECRET_DIR ]] && owner=$(stat -c '%u' "$SECRET_DIR" 2>/dev/null) && mode=$(stat -c '%a' "$SECRET_DIR" 2>/dev/null) && [[ $owner == 0 && $mode == 750 ]] && add SECRET_POLICY PASS 'root-owned mode 0750 directory' || add SECRET_POLICY MANUAL_REVIEW 'documented process must enforce root ownership, directory 0750, files 0440'
required=(compose.yml Caddyfile scripts/preflight.sh scripts/deploy.sh scripts/runtime-audit.sh scripts/network-audit.sh scripts/backup.sh scripts/restore.sh scripts/ops-snapshot.sh scripts/release-evidence.sh scripts/fault-acceptance.sh scripts/final-acceptance.sh scripts/host-preflight.sh scripts/node8j-final-acceptance.mjs scripts/node8j-record-manual.mjs scripts/node8j-evidence.mjs)
missing=(); for file in "${required[@]}"; do [[ -f "$INSTALL_DIR/$file" ]] || missing+=("$file"); done
(( ${#missing[@]} == 0 )) && add FILES PASS 'required production files present' || add FILES MANUAL_REVIEW "install required files: ${missing[*]}"
image=$(awk -F= '/^BAYKUSH_NODE_IMAGE=/{sub(/^[^=]*=/,""); value=$0} END{print value}' "$ENV_FILE" 2>/dev/null || true)
[[ $image =~ ^[^[:space:]@]+@sha256:[0-9a-f]{64}$ ]] && add IMAGE PASS 'release image is digest-pinned' || add IMAGE FAIL 'release image is missing or not digest-pinned'
if [[ -f $COMPOSE_FILE && -f $ENV_FILE ]] && docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config -q >/dev/null 2>&1; then add COMPOSE_CONFIG PASS valid; else add COMPOSE_CONFIG FAIL 'production Compose validation failed'; fi
node - "$results" "$image" "$MIN_DISK_GIB" <<'NODE'
const fs=require('node:fs'); const [path,image,minDisk]=process.argv.slice(2);
const checks=fs.readFileSync(path,'utf8').trim().split('\n').filter(Boolean).map(line=>{const [id,status,...detail]=line.split('\t');return{id,status,detail:detail.join(' ')}});
const result=checks.some(x=>x.status==='FAIL')?'FAIL':checks.some(x=>x.status==='MANUAL_REVIEW')?'MANUAL_REVIEW':'PASS';
const evidence={schemaVersion:'NODE8_HOST_PREFLIGHT_V1',result,observedAt:new Date().toISOString(),releaseImage:image||null,minimumDiskGiB:Number(minDisk),checks,providerIndependent:true,containsSecrets:false};
process.stdout.write(JSON.stringify(evidence,null,2)+'\n'); process.exitCode=result==='FAIL'?1:result==='MANUAL_REVIEW'?2:0;
NODE

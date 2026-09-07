#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}

fail() { printf 'runtime-audit: %s\n' "$*" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"

services=(migrate api scheduler worker backfill normalizer measurement discovery stream-worker recovery-worker)

inspect() { docker inspect -f "$1" "$2"; }
assert_zero_effective_caps() {
  local service=$1 container=$2 cap_eff
  cap_eff=$(docker exec "$container" sh -c "awk '/^CapEff:/ { print \$2 }' /proc/1/status")
  [[ "$cap_eff" =~ ^0+$ ]] || fail "$service has effective capabilities: $cap_eff"
}

for service in "${services[@]}"; do
  container=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$service" 2>/dev/null || true)
  if [[ "$service" == migrate && -z "$container" ]]; then
    # The migration gate is intentionally one-shot and normally absent after deploy.
    continue
  fi
  [[ -n "$container" ]] || fail "$service is not running"

  user=$(inspect '{{.Config.User}}' "$container")
  readonly=$(inspect '{{.HostConfig.ReadonlyRootfs}}' "$container")
  pids=$(inspect '{{.HostConfig.PidsLimit}}' "$container")
  security=$(inspect '{{json .HostConfig.SecurityOpt}}' "$container")
  capdrop=$(inspect '{{json .HostConfig.CapDrop}}' "$container")
  capadd=$(inspect '{{json .HostConfig.CapAdd}}' "$container")
  memory=$(inspect '{{.HostConfig.Memory}}' "$container")
  nano_cpus=$(inspect '{{.HostConfig.NanoCpus}}' "$container")
  privileged=$(inspect '{{.HostConfig.Privileged}}' "$container")
  network_mode=$(inspect '{{.HostConfig.NetworkMode}}' "$container")
  tmpfs=$(inspect '{{json .HostConfig.Tmpfs}}' "$container")
  mounts=$(inspect '{{range .Mounts}}{{.Source}}|{{.Destination}}|{{.RW}}{{println}}{{end}}' "$container")

  [[ -n "$user" && "$user" != 0 && "$user" != root ]] || fail "$service must run as a non-root image user"
  [[ "$readonly" == true ]] || fail "$service root filesystem is not read-only"
  [[ "$pids" =~ ^[0-9]+$ && "$pids" -gt 0 ]] || fail "$service has no PID limit"
  [[ "$memory" =~ ^[0-9]+$ && "$memory" -gt 0 ]] || fail "$service has no memory limit"
  [[ "$nano_cpus" =~ ^[0-9]+$ && "$nano_cpus" -gt 0 ]] || fail "$service has no CPU limit"
  [[ "$security" == *no-new-privileges* ]] || fail "$service lacks no-new-privileges"
  [[ "$capdrop" == *ALL* ]] || fail "$service does not drop all Linux capabilities"
  [[ "$capadd" == null || "$capadd" == '[]' ]] || fail "$service regains Linux capabilities: $capadd"
  [[ "$privileged" == false ]] || fail "$service is privileged"
  [[ "$network_mode" != host ]] || fail "$service uses host networking"
  [[ "$tmpfs" == *'"/tmp"'* && "$tmpfs" == *noexec* && "$tmpfs" == *nosuid* && "$tmpfs" == *nodev* && "$tmpfs" == *size=* ]] || fail "$service /tmp tmpfs is not bounded and hardened: $tmpfs"
  [[ "$mounts" != *'/var/run/docker.sock'* ]] || fail "$service mounts the Docker socket"
  while IFS='|' read -r source destination writable; do
    [[ -z "$destination" || "$writable" == false || ( "$service" == recovery-worker && "$destination" == /var/lib/baykush/recovery ) ]] \
      || fail "$service has unexpected writable mount $destination from $source"
  done <<< "$mounts"
  assert_zero_effective_caps "$service" "$container"
done

caddy=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q caddy)
[[ -n "$caddy" ]] || fail 'caddy is not running'
[[ $(inspect '{{.HostConfig.ReadonlyRootfs}}' "$caddy") == true ]] || fail 'caddy root filesystem is not read-only'
[[ $(inspect '{{json .HostConfig.SecurityOpt}}' "$caddy") == *no-new-privileges* ]] || fail 'caddy lacks no-new-privileges'
[[ $(inspect '{{json .HostConfig.CapDrop}}' "$caddy") == *ALL* ]] || fail 'caddy does not drop all default capabilities'
[[ $(inspect '{{json .HostConfig.CapAdd}}' "$caddy") == '["CAP_NET_BIND_SERVICE"]' ]] || fail 'caddy must regain only NET_BIND_SERVICE'
[[ $(inspect '{{.HostConfig.PidsLimit}}' "$caddy") -gt 0 ]] || fail 'caddy has no PID limit'
[[ $(inspect '{{.HostConfig.Memory}}' "$caddy") -gt 0 ]] || fail 'caddy has no memory limit'
[[ $(inspect '{{.HostConfig.NanoCpus}}' "$caddy") -gt 0 ]] || fail 'caddy has no CPU limit'
caddy_cap_eff=$(docker exec "$caddy" sh -c "awk '/^CapEff:/ { print \$2 }' /proc/1/status")
[[ "$caddy_cap_eff" == 0000000000000400 ]] || fail "caddy effective capabilities are not limited to NET_BIND_SERVICE: $caddy_cap_eff"

# Database is a deliberate writable-rootfs exception because the official image
# performs bootstrap/runtime filesystem work. It still must remain internal and
# resource bounded.
postgres=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q postgres)
[[ -n "$postgres" ]] || fail 'postgres is not running'
[[ $(docker inspect -f '{{.HostConfig.PidsLimit}}' "$postgres") -gt 0 ]] || fail 'postgres has no PID limit'
[[ $(docker inspect -f '{{.HostConfig.Memory}}' "$postgres") -gt 0 ]] || fail 'postgres has no memory limit'
[[ $(docker inspect -f '{{.HostConfig.NanoCpus}}' "$postgres") -gt 0 ]] || fail 'postgres has no CPU limit'
[[ $(docker inspect -f '{{.HostConfig.Privileged}}' "$postgres") == false ]] || fail 'postgres is privileged'
[[ $(docker inspect -f '{{.HostConfig.NetworkMode}}' "$postgres") != host ]] || fail 'postgres uses host networking'

printf 'runtime-audit: PASS\n'

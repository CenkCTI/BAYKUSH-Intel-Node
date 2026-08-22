#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}

fail() { printf 'runtime-audit: %s\n' "$*" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"
[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"

services=(migrate api scheduler worker backfill normalizer measurement discovery stream-worker recovery-worker)

for service in "${services[@]}"; do
  container=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$service" 2>/dev/null || true)
  if [[ "$service" == migrate && -z "$container" ]]; then
    # The migration gate is intentionally one-shot and normally absent after deploy.
    continue
  fi
  [[ -n "$container" ]] || fail "$service is not running"

  user=$(docker inspect -f '{{.Config.User}}' "$container")
  readonly=$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$container")
  pids=$(docker inspect -f '{{.HostConfig.PidsLimit}}' "$container")
  security=$(docker inspect -f '{{json .HostConfig.SecurityOpt}}' "$container")
  capdrop=$(docker inspect -f '{{json .HostConfig.CapDrop}}' "$container")
  memory=$(docker inspect -f '{{.HostConfig.Memory}}' "$container")
  nano_cpus=$(docker inspect -f '{{.HostConfig.NanoCpus}}' "$container")

  [[ -n "$user" && "$user" != 0 && "$user" != root ]] || fail "$service must run as a non-root image user"
  [[ "$readonly" == true ]] || fail "$service root filesystem is not read-only"
  [[ "$pids" =~ ^[0-9]+$ && "$pids" -gt 0 ]] || fail "$service has no PID limit"
  [[ "$memory" =~ ^[0-9]+$ && "$memory" -gt 0 ]] || fail "$service has no memory limit"
  [[ "$nano_cpus" =~ ^[0-9]+$ && "$nano_cpus" -gt 0 ]] || fail "$service has no CPU limit"
  [[ "$security" == *no-new-privileges* ]] || fail "$service lacks no-new-privileges"
  [[ "$capdrop" == *ALL* ]] || fail "$service does not drop all Linux capabilities"
done

# Database is a deliberate writable-rootfs exception because the official image
# performs bootstrap/runtime filesystem work. It still must remain internal and
# resource bounded.
postgres=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q postgres)
[[ -n "$postgres" ]] || fail 'postgres is not running'
[[ $(docker inspect -f '{{.HostConfig.PidsLimit}}' "$postgres") -gt 0 ]] || fail 'postgres has no PID limit'
[[ $(docker inspect -f '{{.HostConfig.Memory}}' "$postgres") -gt 0 ]] || fail 'postgres has no memory limit'

printf 'runtime-audit: PASS\n'

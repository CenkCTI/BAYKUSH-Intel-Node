#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}

fail() { printf 'network-audit: %s\n' "$*" >&2; exit 1; }
for command in docker ss awk node; do command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"; done

# Compose is the authoritative container ingress surface.
published_services=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const c=JSON.parse(s);console.log(Object.entries(c.services).filter(([,v])=>(v.ports??[]).length).map(([n])=>n).join(" "))})')
[[ "$published_services" == caddy ]] || fail "only Caddy may publish container ports; got: $published_services"

# Defense-in-depth host check: database and internal API must never listen on a
# wildcard/public host address. Loopback-only developer tooling is not treated as
# production ingress, but a production host should normally have none.
while read -r local_address; do
  if [[ "$local_address" == "0.0.0.0:5432" || "$local_address" == "[::]:5432" || "$local_address" == "*:5432" ]]; then
    fail 'PostgreSQL is publicly listening on host port 5432'
  fi
  if [[ "$local_address" == "0.0.0.0:8080" || "$local_address" == "[::]:8080" || "$local_address" == "*:8080" ]]; then
    fail 'Node API is publicly listening on host port 8080'
  fi
done < <(ss -H -lnt | awk '{print $4}')

printf 'network-audit: PASS\n'

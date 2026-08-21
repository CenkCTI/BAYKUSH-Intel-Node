#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
SMOKE_SCRIPT=${SMOKE_SCRIPT:-/opt/baykush-node/scripts/smoke-test.sh}
PREFLIGHT_SCRIPT=${PREFLIGHT_SCRIPT:-/opt/baykush-node/scripts/preflight.sh}

"$PREFLIGHT_SCRIPT"

printf 'deploy: pulling exact release images\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull

printf 'deploy: starting PostgreSQL\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres

printf 'deploy: running one-shot migration gate\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm migrate

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

"$SMOKE_SCRIPT"
printf 'deploy: PASS\n'

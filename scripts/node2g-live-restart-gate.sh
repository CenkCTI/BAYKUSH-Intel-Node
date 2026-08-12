#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

sources=(CISA_KEV NVD_CVE FIRST_EPSS THREATFOX MALWAREBAZAAR)

wait_for_final_audit() {
  local label="$1"
  local output=""
  for _ in $(seq 1 60); do
    if output=$(sudo docker compose exec -T api node dist/cli/node2g.js final-audit 2>&1); then
      echo "$output"
      echo "$label final audit accepted"
      return 0
    fi
    sleep 2
  done
  echo "$output"
  echo "$label final audit did not reach a drained accepted state" >&2
  return 1
}

assert_source_health() {
  local bad
  bad=$(sudo docker compose exec -T postgres \
    psql -U baykush -d baykush -At -c "
      SELECT count(*)
        FROM source_definitions d
        JOIN source_health h ON h.source_definition_id = d.id
       WHERE d.source_key IN ('CISA_KEV','NVD_CVE','FIRST_EPSS','THREATFOX','MALWAREBAZAAR')
         AND (d.enabled IS DISTINCT FROM true OR h.health_status <> 'HEALTHY');
    ")
  if [[ "$bad" != "0" ]]; then
    echo "Production source health gate failed: $bad source(s) are disabled or non-HEALTHY" >&2
    return 1
  fi
}

assert_fresh_runtime_heartbeats() {
  local stale
  stale=$(sudo docker compose exec -T postgres \
    psql -U baykush -d baykush -At -c "
      WITH expected(component) AS (
        VALUES ('SCHEDULER'::runtime_component), ('WORKER'::runtime_component), ('NORMALIZER'::runtime_component)
      ), latest AS (
        SELECT component, max(heartbeat_at) AS heartbeat_at
          FROM runtime_heartbeats
         WHERE component IN ('SCHEDULER','WORKER','NORMALIZER')
         GROUP BY component
      )
      SELECT count(*)
        FROM expected e
        LEFT JOIN latest l USING(component)
       WHERE l.heartbeat_at IS NULL
          OR now() - l.heartbeat_at > interval '30 seconds';
    ")
  if [[ "$stale" != "0" ]]; then
    echo "Runtime heartbeat gate failed: $stale component(s) missing/stale" >&2
    return 1
  fi
}

assert_runtime_secret_scope() {
  local service
  for service in api scheduler normalizer; do
    sudo docker compose exec -T "$service" node -e '
      const names=["NVD_API_KEY","THREATFOX_AUTH_KEY","MALWAREBAZAAR_AUTH_KEY"];
      const present=names.filter((name)=>Boolean(process.env[name]));
      if(present.length){console.error(`provider secrets unexpectedly present in non-worker runtime: ${present.join(",")}`);process.exit(1)}
    '
  done

  for service in api scheduler worker normalizer; do
    sudo docker compose exec -T "$service" node -e '
      const names=["SUPABASE_SERVICE_ROLE_KEY","NEXT_PUBLIC_SUPABASE_URL"];
      const present=names.filter((name)=>Boolean(process.env[name]));
      if(present.length){console.error(`private CITEM runtime credentials unexpectedly present: ${present.join(",")}`);process.exit(1)}
    '
  done
}

echo "=== BASELINE CONTAINERS ==="
sudo docker compose ps

echo "=== BASELINE SOURCE STATUS ==="
for source in "${sources[@]}"; do
  sudo docker compose exec -T api node dist/cli/sources.js status "$source"
done
assert_source_health

echo "=== BASELINE FINAL AUDIT ==="
wait_for_final_audit "baseline"

echo "=== RUNTIME SECRET SCOPE ==="
assert_runtime_secret_scope

for service in scheduler worker normalizer; do
  echo "=== RESTART $service ==="
  sudo docker compose restart "$service"
  sleep 12
  sudo docker compose ps "$service"
done

echo "=== HEARTBEATS AFTER RESTART ==="
sudo docker compose exec -T postgres \
  psql -U baykush -d baykush -P pager=off -c "
    SELECT component, instance_id, heartbeat_at,
           round(extract(epoch from (now() - heartbeat_at)))::int AS age_seconds
      FROM runtime_heartbeats
     WHERE component IN ('SCHEDULER','WORKER','NORMALIZER')
     ORDER BY component, instance_id;
  "
assert_fresh_runtime_heartbeats

echo "=== POST-RESTART SOURCE STATUS ==="
for source in "${sources[@]}"; do
  sudo docker compose exec -T api node dist/cli/sources.js status "$source"
done
assert_source_health

echo "=== POST-RESTART FINAL AUDIT ==="
wait_for_final_audit "post-restart"

echo "=== LIVE CREDENTIAL PERSISTENCE / PRIVATE-BOUNDARY AUDIT ==="
sudo docker compose exec -T worker node dist/cli/node2g.js security-audit

echo "=== POST-RESTART RUNTIME SECRET SCOPE ==="
assert_runtime_secret_scope

echo "NODE-2G live restart/isolation operator gate passed"

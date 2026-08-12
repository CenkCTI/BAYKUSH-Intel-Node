#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

sources=(CISA_KEV NVD_CVE FIRST_EPSS THREATFOX MALWAREBAZAAR)

echo "=== BASELINE CONTAINERS ==="
sudo docker compose ps

echo "=== BASELINE SOURCE STATUS ==="
for source in "${sources[@]}"; do
  sudo docker compose exec -T api node dist/cli/sources.js status "$source"
done

echo "=== BASELINE FINAL AUDIT ==="
sudo docker compose exec -T api node dist/cli/node2g.js final-audit

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

echo "=== POST-RESTART SOURCE STATUS ==="
for source in "${sources[@]}"; do
  sudo docker compose exec -T api node dist/cli/sources.js status "$source"
done

echo "=== POST-RESTART FINAL AUDIT ==="
sudo docker compose exec -T api node dist/cli/node2g.js final-audit

echo "=== LIVE CREDENTIAL PERSISTENCE / PRIVATE-BOUNDARY AUDIT ==="
sudo docker compose exec -T worker node dist/cli/node2g.js security-audit

echo "NODE-2G live restart/isolation operator gate passed"

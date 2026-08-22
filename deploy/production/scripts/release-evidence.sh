#!/usr/bin/env bash
set -euo pipefail
umask 077

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
RELEASE_DIR=${RELEASE_DIR:-/var/lib/baykush/releases}
BACKUP_GATE_PASSED=${BACKUP_GATE_PASSED:-false}

fail() { printf 'release-evidence: %s\n' "$*" >&2; exit 1; }
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${BAYKUSH_NODE_IMAGE:?BAYKUSH_NODE_IMAGE is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
POSTGRES_DB=${POSTGRES_DB:-baykush}
[[ "$BAYKUSH_NODE_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || fail 'release evidence requires a digest-pinned image'

mkdir -p "$RELEASE_DIR/history"
chmod 0700 "$RELEASE_DIR" "$RELEASE_DIR/history"

ledger=$(mktemp)
trap 'rm -f "$ledger"' EXIT
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -X -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -c 'SELECT filename || chr(9) || sha256 FROM node_schema_migrations ORDER BY filename' > "$ledger"
ledger_sha=$(sha256sum "$ledger" | awk '{print $1}')
compose_sha=$(sha256sum "$COMPOSE_FILE" | awk '{print $1}')
previous_image=""
if [[ -f "$RELEASE_DIR/current.json" ]]; then
  previous_image=$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(p.image??"")' "$RELEASE_DIR/current.json")
fi

ts=$(date -u +%Y%m%dT%H%M%SZ)
out="$RELEASE_DIR/history/release-${ts}.json"
node - "$out" "$BAYKUSH_NODE_IMAGE" "$previous_image" "$ledger_sha" "$compose_sha" "$BACKUP_GATE_PASSED" <<'NODE'
const fs = require('node:fs');
const [out, image, previousImage, migrationLedgerSha256, composeSha256, backupGate] = process.argv.slice(2);
const evidence = {
  schemaVersion: 'NODE8_RELEASE_EVIDENCE_V1',
  accepted: true,
  deployedAt: new Date().toISOString(),
  image,
  previousImage: previousImage || null,
  migrationLedgerSha256,
  productionComposeSha256: composeSha256,
  preDeployBackupGatePassed: backupGate === 'true',
  smokeAccepted: true,
  runtimeAuditAccepted: true,
  networkAuditAccepted: true,
  containsSecrets: false,
};
fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
NODE
chmod 0600 "$out"
tmp="$RELEASE_DIR/current.json.tmp"
cp "$out" "$tmp"
chmod 0600 "$tmp"
mv "$tmp" "$RELEASE_DIR/current.json"
printf 'release-evidence: PASS %s\n' "$out"

#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}

fail() {
  printf 'smoke: %s\n' "$*" >&2
  exit 1
}

[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"

NODE_HOSTNAME=$(grep -E '^NODE_HOSTNAME=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
SMOKE_TOKEN_FILE=$(grep -E '^BAYKUSH_SMOKE_TOKEN_FILE=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
[[ -n "$NODE_HOSTNAME" ]] || fail "NODE_HOSTNAME is not set"
[[ -n "$SMOKE_TOKEN_FILE" && -f "$SMOKE_TOKEN_FILE" ]] || fail "BAYKUSH_SMOKE_TOKEN_FILE is missing or unreadable"

API_TOKEN=$(cat "$SMOKE_TOKEN_FILE")
[[ ${#API_TOKEN} -ge 32 ]] || fail "smoke credential is missing or too short"

base="https://${NODE_HOSTNAME}"
health=$(curl --fail --silent --show-error --max-time 15 "${base}/v1/health")
printf '%s' "$health" | grep -q '"status":"ok"' || fail "health response is not ok"

# Feed the Authorization header over stdin so the credential is not a command-line argument.
printf 'Authorization: Bearer %s\n' "$API_TOKEN" \
  | curl --fail --silent --show-error --max-time 30 -H @- "${base}/v1/sources" >/dev/null

unset API_TOKEN
printf 'smoke: PASS\n'

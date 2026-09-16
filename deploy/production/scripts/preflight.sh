#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}
ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}

fail() {
  printf 'preflight: %s\n' "$*" >&2
  exit 1
}

for command in docker awk stat grep sort tr; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable"
docker compose version >/dev/null 2>&1 || fail "Docker Compose plugin is unavailable"

[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"

mode=$(stat -c '%a' "$ENV_FILE")
case "$mode" in
  600|400) ;;
  *) fail "$ENV_FILE must be mode 0600 or 0400; got $mode" ;;
esac

owner=$(stat -c '%U:%G' "$ENV_FILE")
[[ "$owner" == "root:root" ]] || fail "$ENV_FILE must be owned by root:root; got $owner"

image=$(grep -E '^BAYKUSH_NODE_IMAGE=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
hostname=$(grep -E '^NODE_HOSTNAME=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
secret_dir=$(grep -E '^BAYKUSH_SECRET_DIR=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
secret_gid=$(grep -E '^BAYKUSH_SECRET_GID=' "$ENV_FILE" | tail -n1 | cut -d= -f2- || true)
[[ -n "$image" && "$image" != *REPLACE_ME* ]] || fail "BAYKUSH_NODE_IMAGE is not configured"
[[ -n "$hostname" && "$hostname" != *.invalid ]] || fail "NODE_HOSTNAME is not configured"
[[ -n "$secret_dir" && -d "$secret_dir" ]] || fail "BAYKUSH_SECRET_DIR is missing or is not a directory"
[[ "$secret_gid" =~ ^[0-9]+$ ]] || fail "BAYKUSH_SECRET_GID must be a numeric supplemental group id"

secret_uid=$(stat -c '%u' "$secret_dir")
secret_actual_gid=$(stat -c '%g' "$secret_dir")
secret_mode=$(stat -c '%a' "$secret_dir")
[[ "$secret_uid" == "0" ]] || fail "$secret_dir must be owned by root"
[[ "$secret_actual_gid" == "$secret_gid" ]] || fail "$secret_dir group id must be $secret_gid; got $secret_actual_gid"
[[ "$secret_mode" == "750" ]] || fail "$secret_dir must be mode 0750; got $secret_mode"

for secret_name in postgres_password database_url api_credentials.json smoke_api_token; do
  secret_path="$secret_dir/$secret_name"
  [[ -f "$secret_path" ]] || fail "required secret file missing: $secret_name"
  file_uid=$(stat -c '%u' "$secret_path")
  file_gid=$(stat -c '%g' "$secret_path")
  file_mode=$(stat -c '%a' "$secret_path")
  [[ "$file_uid" == "0" ]] || fail "$secret_name must be owned by root"
  [[ "$file_gid" == "$secret_gid" ]] || fail "$secret_name group id must be $secret_gid"
  [[ "$file_mode" == "440" ]] || fail "$secret_name must be mode 0440; got $file_mode"
done

case "$image" in
  *@sha256:*) ;;
  *:*) printf 'preflight: warning: image is tag-pinned, not digest-pinned: %s\n' "$image" >&2 ;;
  *) fail "BAYKUSH_NODE_IMAGE must be a tag or digest reference" ;;
esac

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config -q

published=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config 2>/dev/null \
  | awk '/^[[:space:]]+published:/ {gsub(/"/,"",$2); print $2}' \
  | sort -u \
  | tr '\n' ' ')
for allowed in 80 443; do
  published=${published//${allowed} /}
done
[[ -z "${published// /}" ]] || fail "unexpected public host port(s) in production compose: $published"

printf 'preflight: PASS\n'

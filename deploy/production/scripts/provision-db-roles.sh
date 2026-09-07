#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/baykush-node/compose.yml}

fail() { printf 'db-role-provision: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root on the production host'
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${BAYKUSH_SECRET_DIR:?BAYKUSH_SECRET_DIR is required}"
: "${BAYKUSH_SECRET_GID:?BAYKUSH_SECRET_GID is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
POSTGRES_DB=${POSTGRES_DB:-baykush}
ROTATE_DB_ROLE_PASSWORDS=${ROTATE_DB_ROLE_PASSWORDS:-false}
[[ "$BAYKUSH_SECRET_GID" =~ ^[0-9]+$ ]] || fail 'BAYKUSH_SECRET_GID must be numeric'
[[ "$POSTGRES_DB" =~ ^[A-Za-z0-9_.-]+$ ]] || fail 'POSTGRES_DB contains characters unsafe for a connection URL'
[[ "$ROTATE_DB_ROLE_PASSWORDS" == false || "$ROTATE_DB_ROLE_PASSWORDS" == true ]] || fail 'ROTATE_DB_ROLE_PASSWORDS must be true or false'

for command in docker openssl stat mktemp chown chmod mv tr; do
  command -v "$command" >/dev/null 2>&1 || fail "missing required command: $command"
done

[[ -d "$BAYKUSH_SECRET_DIR" ]] || fail "secret directory does not exist: $BAYKUSH_SECRET_DIR"
[[ $(stat -c '%u' "$BAYKUSH_SECRET_DIR") == 0 ]] || fail 'secret directory must be root-owned'
[[ $(stat -c '%g' "$BAYKUSH_SECRET_DIR") == "$BAYKUSH_SECRET_GID" ]] || fail 'secret directory GID mismatch'
[[ $(stat -c '%a' "$BAYKUSH_SECRET_DIR") == 750 ]] || fail 'secret directory must be mode 0750'

roles=(api ingest projection stream recovery)
for role in "${roles[@]}"; do
  password_file="$BAYKUSH_SECRET_DIR/db_${role}_password"
  if [[ ! -f "$password_file" || "$ROTATE_DB_ROLE_PASSWORDS" == true ]]; then
    password_tmp=$(mktemp "$BAYKUSH_SECRET_DIR/.db_${role}_password.XXXXXX")
    umask 027
    openssl rand -hex 32 > "$password_tmp"
    chown "0:${BAYKUSH_SECRET_GID}" "$password_tmp"
    chmod 0440 "$password_tmp"
    mv -f "$password_tmp" "$password_file"
  fi
  [[ $(stat -c '%u' "$password_file") == 0 ]] || fail "$password_file must be root-owned"
  [[ $(stat -c '%g' "$password_file") == "$BAYKUSH_SECRET_GID" ]] || fail "$password_file GID mismatch"
  [[ $(stat -c '%a' "$password_file") == 440 ]] || fail "$password_file must be mode 0440"
done

sql_file=$(mktemp)
trap 'rm -f "$sql_file"' EXIT
chmod 0600 "$sql_file"

{
  printf '%s\n' 'BEGIN;'
  printf '%s\n' 'SET LOCAL client_min_messages = error;'
  for role in "${roles[@]}"; do
    login="baykush_${role}_runtime"
    capability="baykush_${role}"
    password=$(tr -d '\r\n' < "$BAYKUSH_SECRET_DIR/db_${role}_password")
    [[ "$password" =~ ^[0-9a-f]{64}$ ]] || fail "db_${role}_password must be a generated 64-character hex secret"
    printf "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '%s') THEN CREATE ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT; END IF; END \$\$;\n" "$login" "$login"
    printf "ALTER ROLE %s LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;\n" "$login"
    printf "ALTER ROLE %s PASSWORD '%s';\n" "$login" "$password"
    printf "DO \$\$ DECLARE inherited text; BEGIN FOR inherited IN SELECT parent.rolname FROM pg_auth_members membership JOIN pg_roles parent ON parent.oid=membership.roleid JOIN pg_roles member ON member.oid=membership.member WHERE member.rolname='%s' LOOP EXECUTE format('REVOKE %%I FROM %%I',inherited,'%s'); END LOOP; END \$\$;\n" "$login" "$login"
    printf "GRANT %s TO %s;\n" "$capability" "$login"
    printf "ALTER ROLE %s SET statement_timeout = '%s';\n" "$login" "$([[ "$role" == api ]] && printf '15s' || printf '120s')"
    printf "ALTER ROLE %s SET idle_in_transaction_session_timeout = '30s';\n" "$login"
    if [[ "$role" == api ]]; then
      printf "ALTER ROLE %s SET default_transaction_read_only = on;\n" "$login"
    fi
  done
  printf '%s\n' 'COMMIT;'
} > "$sql_file"

printf 'db-role-provision: applying bounded login-role configuration\n'
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" < "$sql_file" >/dev/null

for role in "${roles[@]}"; do
  password=$(tr -d '\r\n' < "$BAYKUSH_SECRET_DIR/db_${role}_password")
  url_file="$BAYKUSH_SECRET_DIR/db_${role}_url"
  url_tmp=$(mktemp "$BAYKUSH_SECRET_DIR/.db_${role}_url.XXXXXX")
  printf 'postgresql://baykush_%s_runtime:%s@postgres:5432/%s?application_name=baykush-%s\n' \
    "$role" "$password" "$POSTGRES_DB" "$role" > "$url_tmp"
  chown "0:${BAYKUSH_SECRET_GID}" "$url_tmp"
  chmod 0440 "$url_tmp"
  mv -f "$url_tmp" "$url_file"
done

for required in db_api_url db_ingest_url db_projection_url db_stream_url db_recovery_url; do
  [[ -s "$BAYKUSH_SECRET_DIR/$required" ]] || fail "failed to provision $required"
done

printf 'db-role-provision: PASS\n'

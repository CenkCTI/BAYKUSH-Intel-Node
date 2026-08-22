#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=${ENV_FILE:-/etc/baykush/runtime.env}
IMAGE=${1:-}

fail() { printf 'set-release-image: %s\n' "$*" >&2; exit 1; }
[[ ${EUID:-$(id -u)} -eq 0 ]] || fail 'must run as root'
[[ -f "$ENV_FILE" ]] || fail "runtime env not found: $ENV_FILE"
[[ "$IMAGE" == *@sha256:* ]] || fail 'release image must be digest-pinned'
[[ "$IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || fail 'release image digest format is invalid'

owner=$(stat -c '%U:%G' "$ENV_FILE")
mode=$(stat -c '%a' "$ENV_FILE")
[[ "$owner" == root:root ]] || fail "$ENV_FILE must be root:root"
case "$mode" in 600|400) ;; *) fail "$ENV_FILE must be mode 0600/0400" ;; esac

tmp=$(mktemp "${ENV_FILE}.tmp.XXXXXXXX")
trap 'rm -f "$tmp"' EXIT
awk -v image="$IMAGE" '
  BEGIN { replaced=0 }
  /^BAYKUSH_NODE_IMAGE=/ { print "BAYKUSH_NODE_IMAGE=" image; replaced=1; next }
  { print }
  END { if (!replaced) print "BAYKUSH_NODE_IMAGE=" image }
' "$ENV_FILE" > "$tmp"
chown root:root "$tmp"
chmod "$mode" "$tmp"
mv "$tmp" "$ENV_FILE"
trap - EXIT
printf 'set-release-image: PASS\n'

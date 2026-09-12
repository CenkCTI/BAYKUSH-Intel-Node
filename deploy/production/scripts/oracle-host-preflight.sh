#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
printf '%s\n' 'oracle-host-preflight.sh is deprecated; use host-preflight.sh' >&2
exec "$SCRIPT_DIR/host-preflight.sh" "$@"

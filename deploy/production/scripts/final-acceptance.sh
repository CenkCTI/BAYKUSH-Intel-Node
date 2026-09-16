#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOL_DIR=$SCRIPT_DIR
[[ -f "$TOOL_DIR/node8j-final-acceptance.mjs" ]] || TOOL_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)/scripts
exec node "$TOOL_DIR/node8j-final-acceptance.mjs" "$@"

#!/usr/bin/env bash
set -euo pipefail
umask 077
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TOOL_DIR=$SCRIPT_DIR
[[ -f "$TOOL_DIR/node8j-record-manual.mjs" ]] || TOOL_DIR=$(cd "$SCRIPT_DIR/../../.." && pwd)/scripts
: "${NODE8J_SCENARIO:?NODE8J_SCENARIO is required}"
: "${NODE8J_RESULT:?NODE8J_RESULT must be PASS or FAIL}"
: "${NODE8J_HOST_ID:?NODE8J_HOST_ID is required}"
: "${NODE8J_RELEASE_IMAGE:?NODE8J_RELEASE_IMAGE is required}"
: "${NODE8J_EVIDENCE_DIR:?NODE8J_EVIDENCE_DIR is required}"
NODE8J_OPERATOR_NOTE=${NODE8J_OPERATOR_NOTE:-}
NODE8J_REFERENCE_FILES=${NODE8J_REFERENCE_FILES:-}
mkdir -p "$NODE8J_EVIDENCE_DIR"
chmod 0700 "$NODE8J_EVIDENCE_DIR"
exec node "$TOOL_DIR/node8j-record-manual.mjs"

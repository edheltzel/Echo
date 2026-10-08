#!/bin/bash
# Output mode - thin curl wrapper over POST /mode + GET /health.
#   mode.sh speech | sounds | status
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"

usage() {
  echo "Usage: $(basename "$0") speech|sounds|status" >&2
  exit 2
}

mode_value() {
  printf '%s' "$1" | tr -d '\n' | sed -n 's/.*"mode"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1
}

cmd="${1:-}"
[ $# -le 1 ] || usage

case "$cmd" in
  speech|sounds)
    response="$(echo_http POST "$ECHO_BASE_URL/mode" "{\"mode\":\"$cmd\"}")" || exit 1
    printf '%s\n' "$response"
    ;;
  status)
    response="$(echo_http GET "$HEALTH_URL")" || exit 1
    echo "Mode: $(mode_value "$response")"
    ;;
  *) usage ;;
esac

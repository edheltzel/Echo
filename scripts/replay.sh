#!/bin/bash
# Replay last N spoken notify lines (FM-449) - thin curl wrapper over POST /replay.
#   replay.sh [n]     # default n=1; n is 1..10
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"

usage() {
  echo "Usage: $(basename "$0") [n]   # re-speak the last n spoken lines (default 1, max 10)" >&2
  exit 2
}

n=1
if [ $# -ge 1 ]; then
  case "${1:-}" in
    -h|--help) usage ;;
  esac
  [ $# -eq 1 ] || usage
  [[ "$1" =~ ^([1-9]|10)$ ]] || usage
  n=$((10#$1))
fi

body="{\"n\": $n}"
response="$(echo_http POST "$ECHO_BASE_URL/replay" "$body")" || exit 1
echo "$response"

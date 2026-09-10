#!/bin/bash
# Replay last N spoken notify lines (FM-449) - thin curl wrapper over POST /replay.
#   replay.sh [n]     # default n=1; n is 1..10
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"
CURL=(curl --connect-timeout 2 --max-time 5 -fsS)

usage() {
  echo "Usage: $(basename "$0") [n]   # re-speak the last n spoken lines (default 1, max 10)" >&2
  exit 2
}

# curl -f exit 22 = the daemon answered with an HTTP error (4xx/5xx);
# anything else (7 refused, 28 timeout, ...) = not reachable at all.
fail_from_curl() {
  local rc="$1"
  if [ "$rc" -eq 22 ]; then
    echo "echo daemon rejected the request (HTTP error on :${ECHO_PORT})" >&2
  else
    echo "echo daemon not reachable on :${ECHO_PORT}" >&2
  fi
  exit 1
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
rc=0; response="$("${CURL[@]}" -X POST "$ECHO_BASE_URL/replay" -H 'Content-Type: application/json' -d "$body" 2>/dev/null)" || rc=$?
[ "$rc" -eq 0 ] || fail_from_curl "$rc"
echo "$response"

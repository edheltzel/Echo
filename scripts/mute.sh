#!/bin/bash
# Runtime mute control (#83) — thin curl wrapper over POST /mute + GET /health.
#   mute.sh on [minutes] | off | toggle | status
set -euo pipefail
PORT="${PORT:-8888}"
BASE_URL="http://localhost:${PORT}"
CURL=(curl --connect-timeout 2 --max-time 5 -fsS)

usage() {
  echo "Usage: $(basename "$0") on [minutes] | off | toggle | status" >&2
  exit 2
}

unreachable() {
  echo "echo daemon not reachable on :${PORT}" >&2
  exit 1
}

cmd="${1:-}"
body=""
case "$cmd" in
  on)
    if [ $# -ge 2 ]; then
      [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -gt 0 ] || usage
      body="{\"muted\": true, \"duration_minutes\": $2}"
    else
      body='{"muted": true}'
    fi
    ;;
  off) body='{"muted": false}' ;;
  toggle) ;; # empty body = toggle (KTD4)
  status)
    health="$("${CURL[@]}" "$BASE_URL/health" 2>/dev/null)" || unreachable
    # The mute block is flat ({muted, muted_until}), so a non-greedy brace
    # match extracts it without a JSON parser dependency.
    echo "$health" | grep -o '"mute":{[^}]*}' || echo "$health"
    exit 0
    ;;
  *) usage ;;
esac

response="$("${CURL[@]}" -X POST "$BASE_URL/mute" -H 'Content-Type: application/json' -d "$body" 2>/dev/null)" || unreachable
echo "$response"

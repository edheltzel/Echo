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

# curl -f exit 22 = the daemon answered with an HTTP error (4xx/5xx);
# anything else (7 refused, 28 timeout, ...) = not reachable at all.
fail_from_curl() {
  local rc="$1"
  if [ "$rc" -eq 22 ]; then
    echo "echo daemon rejected the request (HTTP error on :${PORT})" >&2
  else
    echo "echo daemon not reachable on :${PORT}" >&2
  fi
  exit 1
}

cmd="${1:-}"
body=""
case "$cmd" in
  on)
    if [ $# -ge 2 ]; then
      [[ "$2" =~ ^[0-9]+$ ]] || usage
      minutes=$((10#$2)) # normalize leading zeros — 007 is not a legal JSON number
      [ "$minutes" -gt 0 ] || usage
      body="{\"muted\": true, \"duration_minutes\": $minutes}"
    else
      body='{"muted": true}'
    fi
    ;;
  off) body='{"muted": false}' ;;
  toggle) ;; # empty body = toggle (KTD4)
  status)
    rc=0; health="$("${CURL[@]}" "$BASE_URL/health" 2>/dev/null)" || rc=$?
    [ "$rc" -eq 0 ] || fail_from_curl "$rc"
    # The mute block is flat ({muted, muted_until}), so a non-greedy brace match
    # extracts it without a JSON parser dependency; re-wrap in braces so the
    # output is a parseable JSON document.
    if fragment="$(echo "$health" | grep -o '"mute":{[^}]*}')"; then
      echo "{$fragment}"
    else
      echo "$health"
    fi
    exit 0
    ;;
  *) usage ;;
esac

rc=0; response="$("${CURL[@]}" -X POST "$BASE_URL/mute" -H 'Content-Type: application/json' -d "$body" 2>/dev/null)" || rc=$?
[ "$rc" -eq 0 ] || fail_from_curl "$rc"
echo "$response"

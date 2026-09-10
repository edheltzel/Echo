#!/bin/bash
# Runtime mute control (#83 / FM-446) - thin curl wrapper over POST /mute + GET /health.
#   mute.sh on [tts|mic|all] [minutes] | on [minutes] [tts|mic|all]
#   mute.sh off | toggle [tts|mic|all] | status
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"
CURL=(curl --connect-timeout 2 --max-time 5 -fsS)

usage() {
  echo "Usage: $(basename "$0") on [tts|mic|all] [minutes] | off | toggle [tts|mic|all] | status" >&2
  exit 2
}

is_scope() {
  case "${1:-}" in
    tts|mic|all) return 0 ;;
    *) return 1 ;;
  esac
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

cmd="${1:-}"
body=""
scope=""
minutes=""

case "$cmd" in
  on)
    shift
    for arg in "$@"; do
      if is_scope "$arg"; then
        [ -z "$scope" ] || usage
        scope="$arg"
      elif [[ "$arg" =~ ^[0-9]+$ ]]; then
        [ -z "$minutes" ] || usage
        minutes=$((10#$arg)) # normalize leading zeros - 007 is not a legal JSON number
        [ "$minutes" -gt 0 ] || usage
      else
        usage
      fi
    done
    if [ -n "$minutes" ] && [ -n "$scope" ]; then
      body="{\"muted\": true, \"duration_minutes\": $minutes, \"scope\": \"$scope\"}"
    elif [ -n "$minutes" ]; then
      body="{\"muted\": true, \"duration_minutes\": $minutes}"
    elif [ -n "$scope" ]; then
      body="{\"muted\": true, \"scope\": \"$scope\"}"
    else
      body='{"muted": true}'
    fi
    ;;
  off) body='{"muted": false}' ;;
  toggle)
    if [ $# -ge 2 ]; then
      is_scope "$2" || usage
      [ $# -eq 2 ] || usage
      body="{\"scope\": \"$2\"}"
    fi
    ;; # empty body = toggle all (KTD4); {"scope":"tts"} toggles that scope
  status)
    rc=0; health="$("${CURL[@]}" "$ECHO_BASE_URL/health" 2>/dev/null)" || rc=$?
    [ "$rc" -eq 0 ] || fail_from_curl "$rc"
    # The mute block is flat ({muted, muted_until, scope}), so a non-greedy
    # brace match extracts it without a JSON parser dependency; re-wrap in
    # braces so the output is a parseable JSON document.
    if fragment="$(echo "$health" | grep -o '"mute":{[^}]*}')"; then
      echo "{$fragment}"
    else
      echo "$health"
    fi
    exit 0
    ;;
  *) usage ;;
esac

rc=0; response="$("${CURL[@]}" -X POST "$ECHO_BASE_URL/mute" -H 'Content-Type: application/json' -d "$body" 2>/dev/null)" || rc=$?
[ "$rc" -eq 0 ] || fail_from_curl "$rc"
echo "$response"

#!/bin/bash
# Runtime mute control (#83 / FM-446 / FM-601) - thin curl wrapper over POST /mute + GET /health.
#   mute.sh on [tts|mic|all] [minutes] | on [minutes] [tts|mic|all]
#   mute.sh off | toggle [tts|mic|all] | status
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"

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

# Flatten a POST /mute body or a /health document to the mute object.
mute_object() {
  local raw="$1" nested
  nested="$(printf '%s' "$raw" | grep -o '"mute":{[^}]*}' | head -1 || true)"
  if [ -n "$nested" ]; then
    printf '%s' "$nested" | sed 's/^"mute"://'
  else
    printf '%s' "$raw"
  fi
}

mute_bool() {
  printf '%s' "$1" | tr -d '\n' | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*(true|false)" | grep -oE 'true|false' | head -1 || true
}

mute_str() {
  printf '%s' "$1" | tr -d '\n' | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -1 || true
}

# Human status for on/off/toggle/status. `muted` is the speaker flag, so mic-only
# stores muted=false — ON/OFF here means "any mute target is held", not that flag.
print_mute_human() {
  local obj muted scope until speaker=off microphone=off
  obj="$(mute_object "$1")"
  muted="$(mute_bool "$obj" muted)"
  scope="$(mute_str "$obj" scope)"
  until="$(mute_str "$obj" muted_until)"
  if [ -z "$scope" ]; then
    scope="all"
  fi

  case "$scope" in
    mic) microphone=on ;;
    tts)
      if [ "$muted" = true ]; then
        speaker=on
      fi
      ;;
    *)
      if [ "$muted" = true ]; then
        speaker=on
        microphone=on
      fi
      ;;
  esac

  if [ "$speaker" = on ] || [ "$microphone" = on ]; then
    echo "Mute: ON"
  else
    echo "Mute: OFF"
  fi

  local targets=""
  if [ "$speaker" = on ]; then
    targets="speaker"
  fi
  if [ "$microphone" = on ]; then
    if [ -n "$targets" ]; then
      targets="${targets}, microphone"
    else
      targets="microphone"
    fi
  fi
  if [ -n "$targets" ]; then
    echo "Targets: ${targets}"
  else
    echo "Targets: none"
  fi
  if [ -n "$until" ]; then
    echo "Until: ${until}"
  fi
}

cmd="${1:-}"
body=""
scope=""
minutes=""
print_status_only=0

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
      # Empty POST toggles `all` (KTD4 / #83). An older staged payload rejects
      # `{"scope":"all"}` without `muted` with HTTP 400; keep that spelling for
      # tts/mic, which those payloads never understood anyway.
      if [ "$2" != "all" ]; then
        body="{\"scope\": \"$2\"}"
      fi
    fi
    ;;
  status)
    print_status_only=1
    ;;
  *) usage ;;
esac

if [ "$print_status_only" -eq 1 ]; then
  response="$(echo_http GET "$HEALTH_URL")" || exit 1
  print_mute_human "$response"
  exit 0
fi

response="$(echo_http POST "$ECHO_BASE_URL/mute" "$body")" || exit 1
print_mute_human "$response"

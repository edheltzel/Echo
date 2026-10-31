#!/bin/bash
# Runtime mute control (#83 / FM-446 / FM-601) - thin curl wrapper over POST /mute + GET /health.
#   mute.sh on [tts|mic|all] [minutes] | on [minutes] [tts|mic|all]
#   mute.sh until HH:MM [tts|mic|all]   (absolute; today, or tomorrow if past)
#   mute.sh off | toggle [tts|mic|all] | status
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"

usage() {
  echo "Usage: $(basename "$0") on [tts|mic|all] [minutes] | until HH:MM [tts|mic|all] | off | toggle [tts|mic|all] | status" >&2
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
  local obj muted scope until mode speaker=off microphone=off
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
  mode="$(mute_str "$1" mode)"
  if [ -n "$mode" ]; then
    echo "Mode: ${mode}"
  fi
  if [ -n "$until" ]; then
    local local_until
    local_until="$(local_clock "$until")"
    if [ -n "$local_until" ]; then
      echo "Until: ${local_until} (${until})"
    else
      echo "Until: ${until}"
    fi
  fi
}


# --- absolute mute (ATL-ECHO-SNOOZE-DASH-01) ---------------------------------
# GNU date (-d) vs BSD/macOS date (-j -f / -v / -r). ECHO_NOW_EPOCH pins "now"
# for tests only.
date_is_gnu() { date --version >/dev/null 2>&1; }

now_epoch() { printf '%s' "${ECHO_NOW_EPOCH:-$(date +%s)}"; }

# Local calendar day for epoch + N days (calendar arithmetic, DST-safe).
local_day() {
  local epoch="$1" add="$2"
  if date_is_gnu; then
    date -d "@$epoch $add days" +%Y-%m-%d 2>/dev/null || date -d "$(date -d "@$epoch" +%Y-%m-%d) +$add days" +%Y-%m-%d
  else
    date -j -r "$epoch" -v+"${add}"d +%Y-%m-%d
  fi
}

# Local "YYYY-MM-DD HH:MM" -> epoch; fails for a wall time that does not exist.
local_epoch() {
  local e back
  if date_is_gnu; then
    e="$(date -d "$1" +%s 2>/dev/null)" || return 1
    back="$(date -d "@$e" '+%Y-%m-%d %H:%M')"
  else
    e="$(date -j -f '%Y-%m-%d %H:%M:%S' "$1:00" +%s 2>/dev/null)" || return 1
    back="$(date -j -r "$e" '+%Y-%m-%d %H:%M')"
  fi
  [ "$back" = "$1" ] || return 1 # DST gap: the wall time was shifted
  printf '%s' "$e"
}

utc_iso() {
  if date_is_gnu; then date -u -d "@$1" +%Y-%m-%dT%H:%M:%S.000Z
  else date -u -r "$1" +%Y-%m-%dT%H:%M:%S.000Z; fi
}

# HH:MM -> UTC ISO of the next future occurrence (today, else tomorrow).
resolve_clock_until() {
  local clock="$1" now day e add
  [[ "$clock" =~ ^([01]?[0-9]|2[0-3]):([0-5][0-9])$ ]] || return 1
  clock="$(printf '%02d:%s' "$((10#${BASH_REMATCH[1]}))" "${BASH_REMATCH[2]}")"
  now="$(now_epoch)"
  for add in 0 1; do
    day="$(local_day "$now" "$add")" || return 1
    e="$(local_epoch "$day $clock")" || return 1
    if [ "$e" -gt "$now" ]; then utc_iso "$e"; return 0; fi
  done
  return 1
}

# UTC ISO -> "3:30 PM" in local time (blank if unparseable).
local_clock() {
  local iso="${1%.*}" e
  iso="${iso%Z}"
  if date_is_gnu; then e="$(date -u -d "${iso/T/ }" +%s 2>/dev/null)" || return 0
  else e="$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "$iso" +%s 2>/dev/null)" || return 0; fi
  if date_is_gnu; then date -d "@$e" '+%a %-I:%M %p'
  else date -j -r "$e" '+%a %-I:%M %p'; fi
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
  until)
    shift
    [ $# -ge 1 ] && [ $# -le 2 ] || usage
    if [ $# -eq 2 ]; then is_scope "$2" || usage; scope="$2"; fi
    if ! until_iso="$(resolve_clock_until "$1")"; then
      echo "Invalid time '$1' - use HH:MM (24-hour local time), e.g. 15:30." >&2
      exit 2
    fi
    if [ -n "$scope" ]; then
      body="{\"muted\": true, \"until\": \"$until_iso\", \"scope\": \"$scope\"}"
    else
      body="{\"muted\": true, \"until\": \"$until_iso\"}"
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

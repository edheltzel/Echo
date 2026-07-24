#!/bin/bash
# Sourced helper: the SINGLE source of the port every Echo shell surface talks to.
# Resolution mirrors the daemon's own (`loadEchoEnvironment` in shared/echo-env.ts):
# a real process variable wins, then the first Echo env file that assigns PORT,
# else 8888.
#
# Every lifecycle script sources this — install.sh, start.sh, stop.sh, status.sh,
# mute.sh, uninstall.sh, and cli/echo — so a `PORT=` in ~/.config/echo/.env moves
# all of them together. Half of them assuming :8888 is what made `echo doctor` and
# `echo status` disagree about the same running daemon.
#
# Pure bash on purpose: it is sourced by scripts that must work without Bun.
#
# Sets ECHO_PORT, ECHO_BASE_URL, HEALTH_URL.

# Every env file the daemon consults, in its precedence order.
echo_env_files() {
  local extra="${ECHO_ENV_PATHS:-${VOICESYSTEM_ENV_PATHS:-}}"
  local p
  if [ -n "$extra" ]; then
    local IFS=":"
    for p in $extra; do
      if [ -n "$p" ]; then printf '%s\n' "$p"; fi
    done
  fi
  printf '%s\n' "$HOME/.config/echo/.env" "$HOME/.config/voicesystem/.env" "$HOME/.env"
}

# First `PORT=<digits>` assignment across those files. Quotes are stripped the
# same way the daemon strips them; anything else is left to the daemon.
resolve_echo_port_from_files() {
  local file value
  while IFS= read -r file; do
    if [ ! -f "$file" ]; then continue; fi
    # `head -1` can SIGPIPE sed; under the callers' `pipefail` that would abort
    # them mid-resolution and silently fall back to 8888.
    value="$({ sed -n "s/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*[\"']\{0,1\}\([0-9][0-9]*\)[\"']\{0,1\}[[:space:]]*\$/\1/p" "$file" | head -1; } || true)"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done <<EOF
$(echo_env_files)
EOF
  return 1
}

# Length is checked before the range so a huge digit string can never reach `[ -ge ]`.
echo_port_is_valid() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

if [ -n "${PORT:-}" ]; then
  ECHO_PORT="$PORT"
else
  ECHO_PORT="$(resolve_echo_port_from_files || true)"
  if [ -z "$ECHO_PORT" ]; then ECHO_PORT=8888; fi
fi

# A malformed port degrades to the default rather than aborting: this file is
# sourced by stop.sh and uninstall.sh, where the port is only a diagnostic note
# and a hard failure would make Echo un-removable.
if ! echo_port_is_valid "$ECHO_PORT"; then
  echo "Ignoring invalid PORT '${ECHO_PORT}' — expected an integer between 1 and 65535; using 8888." >&2
  ECHO_PORT=8888
fi

ECHO_BASE_URL="http://localhost:${ECHO_PORT}"
HEALTH_URL="${ECHO_BASE_URL}/health"
export ECHO_PORT ECHO_BASE_URL HEALTH_URL

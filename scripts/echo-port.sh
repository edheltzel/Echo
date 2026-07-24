#!/bin/bash
# Sourced helper: resolve the port the daemon will ACTUALLY bind, using the
# daemon's own precedence (shared/echo-env.ts) — a real process variable wins,
# then the first Echo env file that assigns PORT, else 8888.
#
# install.sh and cli/echo both source this so the port guard, the plist, the
# post-install health check, and `doctor` all agree with the daemon instead of
# assuming :8888. Assuming it made a `PORT=` in ~/.config/echo/.env look like a
# dead daemon on every install.
#
# Sets ECHO_PORT, HEALTH_URL, and ECHO_PORT_FROM_PROCESS (1 when a real process
# variable supplied it — only then does install.sh write PORT into the plist,
# since the daemon reads the env files for itself).

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

ECHO_PORT_FROM_PROCESS=0
if [ -n "${PORT:-}" ]; then
  ECHO_PORT="$PORT"
  ECHO_PORT_FROM_PROCESS=1
else
  ECHO_PORT="$(resolve_echo_port_from_files || true)"
  if [ -z "$ECHO_PORT" ]; then ECHO_PORT=8888; fi
fi

# ECHO_PORT reaches a LaunchAgent plist, so it is validated, never interpolated blind.
case "$ECHO_PORT" in
  ''|*[!0-9]*)
    echo "Invalid PORT '${ECHO_PORT}' — expected an integer between 1 and 65535." >&2
    exit 2
    ;;
esac
if [ "$ECHO_PORT" -lt 1 ] || [ "$ECHO_PORT" -gt 65535 ]; then
  echo "Invalid PORT '${ECHO_PORT}' — expected an integer between 1 and 65535." >&2
  exit 2
fi

HEALTH_URL="http://localhost:${ECHO_PORT}/health"

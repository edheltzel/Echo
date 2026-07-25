#!/bin/bash
# Sourced helper: the port these shell surfaces talk to — `PORT` when exported,
# else 3246 — plus the one report install.sh and cli/echo both give when that
# port is occupied by something that will not answer /health.
#
# Stage 1 is single-port: install.sh, start/stop/status/mute/uninstall and
# cli/echo all target 3246 and make no attempt to discover a daemon listening
# anywhere else. It does not read legacy dotenv files — and neither does the
# daemon, for PORT specifically (shared/echo-env.ts), so the two sides cannot
# disagree; scripts/install.sh migrates an existing dotenv PORT into config.json
# first. With no live PORT override, the helper reads the flat JSON PORT property
# so the CLI and lifecycle scripts follow the daemon's documented config.
#
# Pure bash on purpose: sourced by scripts that must work without Bun. Values stay
# script-local — every script sources this for itself, nothing is exported.
#
# Sets ECHO_PORT, ECHO_BASE_URL, HEALTH_URL.

# The configured port, or empty when it is absent or in any form config.json
# validation would reject. Grammar AND bounds must match what that validation
# enforces (CANONICAL_DECIMAL and MIN/MAX_CONFIG_PORT in shared/echo-env.ts) and
# what the schema declares, or a value the daemon drops (falling back to 3246)
# would send every shell surface probing a port nothing serves.
#
# The whole value token is captured, not just its leading digits, so a spelling
# the three readers disagree about is rejected here rather than silently
# truncated: `"1e4"` would otherwise read as port 1, and bash arithmetic treats a
# leading-zero operand as octal (`03246` → 1702). 0 is out of range on both sides
# too — it means an ephemeral bind, which no CLI can address, and it reaches the
# daemon only as a live process value in tests.
config_port() {
  local config_path="$HOME/.config/echo/config.json" port
  [ -f "$config_path" ] || return 0
  port="$(sed -nE 's/.*"PORT"[[:space:]]*:[[:space:]]*"?([^",}[:space:]]*)"?[[:space:]]*[,}]?.*/\1/p' "$config_path" | head -1)"
  case "$port" in
    "" | *[!0-9]* | 0*) return 0 ;;
  esac
  [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] || return 0
  echo "$port"
}

if [ -n "${PORT:-}" ]; then
  ECHO_PORT="$PORT"
else
  ECHO_PORT="$(config_port)"
  ECHO_PORT="${ECHO_PORT:-3246}"
fi
ECHO_BASE_URL="http://localhost:${ECHO_PORT}"
# shellcheck disable=SC2034  # read by the scripts that source this file, not here
HEALTH_URL="${ECHO_BASE_URL}/health"
ECHO_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- occupied port ----------------------------------------------------------
# Echo deliberately does NOT classify who owns the port. A foreign process on
# :3246 is what makes our own service fail to bind, so launchd respawns it and
# reports no stable PID — the two states co-occur, and every "is it ours" test
# is guesswork in exactly the case that matters. So: name what lsof saw, give
# both recoveries, let the operator decide. install.sh and cli/echo print these
# same lines so they can never disagree about the same port.

# Identity of whatever listens on ECHO_PORT, e.g. `bun (PID 4242)`; empty when
# nothing holds it or lsof is unavailable.
port_owner() {
  { lsof -nP -iTCP:"${ECHO_PORT}" -sTCP:LISTEN 2>/dev/null \
    | awk 'NR==2 {print $1" (PID "$2")"}'; } || true
}

# PIDs listening on ECHO_PORT, one per line; empty when nothing holds it.
port_listener_pids() {
  { lsof -nP -iTCP:"${ECHO_PORT}" -sTCP:LISTEN -t 2>/dev/null; } || true
}

port_occupied_summary() {
  local owner
  owner="$(port_owner)"
  echo "Port ${ECHO_PORT} is occupied but not answering Echo's /health. Owner: ${owner:-unknown}"
}

port_occupied_advice() {
  echo "If this is Echo's own daemon it may be wedged or crash-looping — check ${LOG_PATH:-$HOME/Library/Logs/echo.log}, then: bash ${ECHO_SCRIPTS_DIR}/restart.sh"
  echo "If another process owns the port, stop it and rerun — Echo never kills the port owner."
}

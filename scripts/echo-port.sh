#!/bin/bash
# Sourced helper: the port these shell surfaces talk to — `PORT` when exported,
# else 3246 — plus the one report install.sh and cli/echo both give when that
# port is occupied by something that will not answer /health.
#
# Stage 1 is single-port: install.sh, start/stop/status/mute/uninstall and
# cli/echo all target 3246 and make no attempt to discover a daemon listening
# anywhere else. Nothing here reads ~/.config/echo/.env or any other env file —
# the daemon owns that parsing, and a second parser in bash could only drift from
# it. Exporting PORT aims one command at one specific daemon (an isolated test
# instance); it does not configure the installed LaunchAgent, whose environment
# is HOME and PATH only.
#
# Pure bash on purpose: sourced by scripts that must work without Bun. Values stay
# script-local — every script sources this for itself, nothing is exported.
#
# Sets ECHO_PORT, ECHO_BASE_URL, HEALTH_URL.

ECHO_PORT="${PORT:-3246}"
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

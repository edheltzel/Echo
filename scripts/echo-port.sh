#!/bin/bash
# Sourced helper: the port these shell surfaces talk to — `PORT` when exported,
# else 8888 — plus the port-ownership questions install.sh and cli/echo both ask
# about it.
#
# Stage 1 is single-port: install.sh, start/stop/status/mute/uninstall and
# cli/echo all target 8888 and make no attempt to discover a daemon listening
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

ECHO_PORT="${PORT:-8888}"
ECHO_BASE_URL="http://localhost:${ECHO_PORT}"
HEALTH_URL="${ECHO_BASE_URL}/health"

# --- port ownership ---------------------------------------------------------
# install.sh (refusing to install over a foreign owner) and cli/echo doctor
# (diagnosing the same state) must answer "whose port is this?" identically, or
# one of them tells the operator to stop a process the other calls Echo's own.

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

# PID launchd reports for label $1; empty when it is not running. `launchctl list
# <label>` exits 113 for an unloaded label and `head -1` can SIGPIPE its producer,
# so the pipeline is neutralized — under `pipefail` either would abort the caller
# at the assignment, killing the very diagnostic it was about to print.
service_pid() {
  { launchctl list "$1" 2>/dev/null \
    | sed -n 's/.*"PID"[[:space:]]*=[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -1; } || true
}

# True when the launchd service $1 is what holds ECHO_PORT. Matching the listener
# against launchd's reported PID is the definitive test; "the label is loaded" is
# the fallback for a crash-looping service launchd reports without a PID. grep
# reads all of its input on purpose: `grep -q` exits early and can SIGPIPE
# launchctl, which `pipefail` would then read as "not loaded".
service_owns_port() {
  local label="$1" svc_pid pid
  svc_pid="$(service_pid "$label")"
  if [ -n "$svc_pid" ]; then
    for pid in $(port_listener_pids); do
      if [ "$pid" = "$svc_pid" ]; then return 0; fi
    done
    return 1
  fi
  launchctl list 2>/dev/null | grep "$label" >/dev/null 2>&1
}

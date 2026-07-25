#!/bin/bash
# Sourced helper: the port these shell surfaces talk to — `PORT` when exported,
# else 8888. That is the whole resolution.
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

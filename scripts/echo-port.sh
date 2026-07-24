#!/bin/bash
# Sourced helper: the port these shell surfaces talk to. `PORT` when exported,
# else 8888.
#
# It deliberately does NOT read ~/.config/echo/.env. The daemon resolves its own
# port from there (`resolveEchoEnv` over `shared/echo-env.ts`), and a second
# parser in bash can only drift from that one — it did: an inline comment on the
# `PORT=` line parsed differently on each side. So there is one parser, in the
# daemon, and these scripts default to 8888 unless you point a command somewhere
# else with `PORT=<n>`. That override addresses a specific running daemon (an
# isolated test instance, a second install); it does not configure the installed
# LaunchAgent, whose environment is only HOME and PATH.
#
# Pure bash on purpose: sourced by scripts that must work without Bun. Values stay
# script-local — every script sources this for itself.
#
# Sets ECHO_PORT, ECHO_BASE_URL, HEALTH_URL.

ECHO_PORT="${PORT:-8888}"
ECHO_BASE_URL="http://localhost:${ECHO_PORT}"
HEALTH_URL="${ECHO_BASE_URL}/health"

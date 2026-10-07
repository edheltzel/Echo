#!/bin/bash
# Sourced helper: the port these shell surfaces talk to. config.json is
# authoritative, an exported PORT is a deprecated one-release fallback, and
# 3246 is the built-in default.
#
# Stage 1 is single-port: install.sh, start/stop/status/mute/uninstall and
# cli/echo all target the resolved port and make no attempt to discover a daemon
# listening anywhere else. This helper does not read legacy dotenv files, and
# neither does the daemon for PORT specifically (shared/echo-env.ts).
#
# Pure bash on purpose: sourced by scripts that must work without Bun. Values stay
# script-local - every script sources this for itself, nothing is exported.
#
# Sets ECHO_PORT, ECHO_BASE_URL, HEALTH_URL.

# The configured port, or empty when it is absent or in any form config.json
# validation would reject. Grammar AND bounds mirror what that validation
# enforces (CANONICAL_DECIMAL and MIN/MAX_CONFIG_PORT in shared/echo-env.ts) and
# what the schema declares: digits only, no sign, no leading zero, no surrounding
# whitespace, 1-65535. A value only one reader accepts would send every shell
# surface probing a port the daemon never bound.
#
# The value is read WHOLE - everything between the quotes, or the bare token -
# never just its leading digits, so a spelling the readers would resolve
# differently is rejected here instead of silently truncated: `"1e4"` would
# otherwise read as port 1, `" 3457 "` as nothing at all, and bash arithmetic
# treats a leading-zero operand as octal (`03246` → 1702). 0 is out of range on
# every side too - it means an ephemeral bind, which no CLI can address, and it
# reaches the daemon only as a live process value in tests.
config_port() {
  local config_path="${ECHO_CONFIG_FILE:-$HOME/.config/echo/config.json}" port
  [ -f "$config_path" ] || return 0
  port="$(sed -nE 's/.*"PORT"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$config_path" | head -1)"
  if [ -z "$port" ]; then
    port="$(sed -nE 's/.*"PORT"[[:space:]]*:[[:space:]]*([^",}[:space:]]+).*/\1/p' "$config_path" | head -1)"
  fi
  case "$port" in
    "" | *[!0-9]* | 0*) return 0 ;;
  esac
  [ "$port" -ge 1 ] 2>/dev/null && [ "$port" -le 65535 ] || return 0
  echo "$port"
}

ECHO_PORT="$(config_port)"
if [ -n "${PORT:-}" ]; then
  echo "WARNING: PORT environment configuration is deprecated; move it to ${ECHO_CONFIG_FILE:-$HOME/.config/echo/config.json}. config.json takes precedence." >&2
  ECHO_PORT="${ECHO_PORT:-$PORT}"
fi
ECHO_PORT="${ECHO_PORT:-3246}"
ECHO_BASE_URL="http://localhost:${ECHO_PORT}"
# shellcheck disable=SC2034  # read by the scripts that source this file, not here
HEALTH_URL="${ECHO_BASE_URL}/health"
ECHO_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- occupied port ----------------------------------------------------------
# Echo deliberately does NOT classify who owns the port. A foreign process on
# :3246 is what makes our own service fail to bind, so launchd respawns it and
# reports no stable PID - the two states co-occur, and every "is it ours" test
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
  echo "If this is Echo's own daemon it may be wedged or crash-looping - check ${LOG_PATH:-$HOME/Library/Logs/echo.log}, then: bash ${ECHO_SCRIPTS_DIR}/restart.sh"
  echo "If another process owns the port, stop it and rerun - Echo never kills the port owner."
}

# --- daemon HTTP -----------------------------------------------------------
# curl -f used to collapse every 4xx/5xx into "HTTP error" and discard the
# body, so `mute toggle all` against an older payload (or a foreign listener)
# looked identical to a mystery reject. These helpers keep the status + body
# and print a recovery that names the port, config path, and start/doctor cmds.
#
# ECHO_HTTP_CODE is set on every call (000 when curl never got an HTTP status).

ECHO_HTTP_CODE=""

_echo_config_path() {
  printf '%s' "${ECHO_CONFIG_FILE:-$HOME/.config/echo/config.json}"
}

# $1 curl_rc  $2 http_code  $3 response body  $4 curl stderr  $5 url
diagnose_echo_http() {
  local rc="$1" code="$2" body="$3" curl_err="${4:-}" url="${5:-}"
  local config_path
  config_path="$(_echo_config_path)"

  if [ "$code" -ge 400 ] 2>/dev/null; then
    echo "echo daemon rejected the request (HTTP ${code} on :${ECHO_PORT})" >&2
    if [ -n "$body" ]; then
      echo "$body" >&2
    fi
    echo "The daemon answered on :${ECHO_PORT}, so this is not a down service." >&2
    echo "If this checkout is newer than the running payload, re-stage: cli/echo update" >&2
    echo "Health: curl -fsS ${HEALTH_URL}" >&2
    echo "Config: ${config_path}" >&2
    return 0
  fi

  echo "echo daemon not reachable on :${ECHO_PORT}" >&2
  case "$rc" in
    7) echo "Nothing accepted a TCP connection (connection refused)." >&2 ;;
    28) echo "Timed out waiting for the daemon." >&2 ;;
    6) echo "Could not resolve the daemon host." >&2 ;;
    *)
      if [ -n "$curl_err" ]; then
        echo "$curl_err" >&2
      fi
      ;;
  esac
  echo "Is the service running?  cli/echo doctor" >&2
  echo "Start it:                bash ${ECHO_SCRIPTS_DIR}/start.sh" >&2
  echo "Or install/re-stage:     cli/echo install" >&2
  echo "Port ${ECHO_PORT} comes from ${config_path} (else default 3246)." >&2
  if [ -n "$url" ]; then
    echo "Tried: ${url}" >&2
  fi
}

# echo_http METHOD URL [json_body]
# Prints the response body to stdout on 2xx. On transport or HTTP error, prints
# diagnose_echo_http to stderr and returns 1. A stub curl that ignores -w and
# exits 0 is treated as HTTP 200 (cli tests).
echo_http() {
  local method="$1" url="$2"
  local have_data=0 data=""
  if [ "$#" -ge 3 ]; then
    have_data=1
    data="$3"
  fi

  local errfile curl_out curl_err curl_rc=0
  errfile="$(mktemp "${TMPDIR:-/tmp}/echo-curl.XXXXXX")"
  if [ "$have_data" -eq 1 ]; then
    curl_out="$(curl --connect-timeout 2 --max-time 5 -sS -w '\n%{http_code}' \
      -X "$method" "$url" -H 'Content-Type: application/json' -d "$data" \
      2>"$errfile")" || curl_rc=$?
  else
    curl_out="$(curl --connect-timeout 2 --max-time 5 -sS -w '\n%{http_code}' \
      -X "$method" "$url" 2>"$errfile")" || curl_rc=$?
  fi
  curl_err="$(cat "$errfile" 2>/dev/null || true)"
  rm -f "$errfile"

  local code body
  code="$(printf '%s\n' "$curl_out" | tail -n 1)"
  body="$(printf '%s\n' "$curl_out" | sed '$d')"
  # Real curl always appends a 3-digit status. Stub curls in tests echo a JSON
  # body and ignore -w; treat a successful run without a status as 200.
  if ! [[ "$code" =~ ^[0-9]{3}$ ]]; then
    if [ "$curl_rc" -eq 0 ]; then
      code="200"
      body="$curl_out"
    else
      code="000"
      body=""
    fi
  fi
  ECHO_HTTP_CODE="$code"

  if [ "$curl_rc" -eq 0 ] && [ "$code" -ge 200 ] 2>/dev/null && [ "$code" -lt 400 ]; then
    # $(...) strips a trailing newline; restore one so callers match `echo`.
    printf '%s\n' "$body"
    return 0
  fi

  diagnose_echo_http "$curl_rc" "$code" "$body" "$curl_err" "$url"
  return 1
}

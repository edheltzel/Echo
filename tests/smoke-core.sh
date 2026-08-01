#!/bin/bash
set -euo pipefail
TEST_PORT="${PORT:-8889}"
unset PORT
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d)"
LOG="${SCRATCH}/core.log"
# CI uploads this repo-root copy on failure (.github/workflows/verify.yml).
ARTIFACT_LOG="${ROOT}/.smoke-core.log"
rm -f "$ARTIFACT_LOG"
export ECHO_CONFIG_FILE="${SCRATCH}/config.json"

# The smoke daemon reads every Echo setting from its own scratch config, never
# the operator's config or state files. PORT remains the test harness input only.
cat >"$ECHO_CONFIG_FILE" <<JSON
{
  "PORT": $TEST_PORT,
  "ECHO_MUTE_STATE_PATH": "$SCRATCH/mute.json",
  "ECHO_CAPTURE_STATE_PATH": "$SCRATCH/recording-state.json"
}
JSON

bun run "$ROOT/core/server.ts" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  status=$?
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" >/dev/null 2>&1 || true
  if [ "$status" -ne 0 ] && [ -f "$LOG" ]; then
    cp "$LOG" "$ARTIFACT_LOG"
  fi
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

for _ in {1..20}; do
  if curl -fsS "http://localhost:${TEST_PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://localhost:${TEST_PORT}/health" >/dev/null

# /notify returns 202 on receipt (synth+play run async on the serial queue).
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://localhost:${TEST_PORT}/notify" \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false,"source":"smoke-test","session_id":"smoke"}')"
if [ "$code" != "202" ]; then
  echo "FAIL: expected 202 on receipt, got $code" >&2
  exit 1
fi

echo "OK core smoke passed on :${TEST_PORT}"

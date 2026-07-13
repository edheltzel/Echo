#!/bin/bash
set -euo pipefail
PORT="${PORT:-8889}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${ROOT}/.smoke-core.log"

# Pin the runtime-mute state (#83) to scratch so the smoke daemon never reads
# (or, via lazy-expiry cleanup, rewrites) the operator's real mute.json.
export ECHO_MUTE_STATE_PATH="$(mktemp -d)/mute.json"

# Pin the capture guard to scratch so a real mic capture on the dev machine
# (e.g. a live VoiceLayer voice_ask) can never flake the smoke.
export ECHO_CAPTURE_STATE_PATH="$(mktemp -d)/recording-state.json"

PORT="$PORT" bun run "$ROOT/core/server.ts" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT

for _ in {1..20}; do
  if curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done

curl -fsS "http://localhost:${PORT}/health" >/dev/null

# /notify returns 202 on receipt (synth+play run async on the serial queue).
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://localhost:${PORT}/notify" \
  -H 'Content-Type: application/json' \
  -d '{"message":"smoke","voice_enabled":false,"source":"smoke-test","session_id":"smoke"}')"
if [ "$code" != "202" ]; then
  echo "FAIL: expected 202 on receipt, got $code" >&2
  exit 1
fi

echo "OK core smoke passed on :${PORT}"

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
# The legacy macOS banner goes to a recorder, never /usr/bin/osascript, so the
# smoke daemon puts nothing on the operator's screen; a recorded line proves it.
BANNER_LOG="${SCRATCH}/banners.log"
printf '#!/bin/bash\necho banner >> "%s"\n' "$BANNER_LOG" >"${SCRATCH}/fake-osascript"
chmod +x "${SCRATCH}/fake-osascript"

# The smoke daemon reads every Echo setting from its own scratch config, never
# the operator's config or state files. PORT remains the test harness input only.
cat >"$ECHO_CONFIG_FILE" <<JSON
{
  "PORT": $TEST_PORT,
  "ECHO_MUTE_STATE_PATH": "$SCRATCH/mute.json",
  "ECHO_CAPTURE_STATE_PATH": "$SCRATCH/recording-state.json",
  "ECHO_OSASCRIPT_BIN": "$SCRATCH/fake-osascript"
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

# The banner fires at accept, just after the 202; give it a moment to land.
for _ in {1..20}; do [ -s "$BANNER_LOG" ] && break; sleep 0.1; done
if [ ! -s "$BANNER_LOG" ]; then
  echo "FAIL: the banner did not go through the scratch ECHO_OSASCRIPT_BIN recorder" >&2
  exit 1
fi

echo "OK core smoke passed on :${TEST_PORT}"

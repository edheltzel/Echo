#!/bin/bash
# End-to-end adapter-boundary test against an ISOLATED daemon instance.
#
# Never touches the operator's running daemon. This script starts its own
# `core/server.ts` on its own port with every state path redirected into a
# scratch directory, asserts the instance it is about to talk to is the one it
# started, and kills only that PID. It refuses to run if anything is already
# listening on the chosen port — it will not attach to a daemon it does not own.
#
#   tests/e2e-adapters.sh              # silent (default; safe anywhere)
#   tests/e2e-adapters.sh --audible    # also speaks the test opener out loud
#   ECHO_E2E_PORT=8912 tests/e2e-adapters.sh
#
# What it proves: the daemon serves GET /voices, the Claude Code adapter reads
# persona keys over that contract (not off disk), and the Pi adapter loads and
# notifies with `@echo/shared` resolved through its own package root.
set -euo pipefail

export ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The production daemon's port. The test instance must never use it, and this
# script must never send anything there.
PRODUCTION_PORT=8888
PORT="${ECHO_E2E_PORT:-8899}"
AUDIBLE=0
[ "${1:-}" = "--audible" ] && AUDIBLE=1

# The one line every spoken test says, so anything audible is unmistakably a test.
TEST_OPENER="Echo Test engaged. Beep, boop, bop."

if [ "$PORT" = "$PRODUCTION_PORT" ]; then
  echo "REFUSING: ECHO_E2E_PORT=$PORT is the production daemon port." >&2
  exit 1
fi

if curl -fsS --max-time 2 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
  echo "REFUSING: something is already listening on :${PORT}." >&2
  echo "This test only ever talks to a daemon it started itself." >&2
  exit 1
fi

SCRATCH="$(mktemp -d)"
LOG="${SCRATCH}/daemon.log"

# Every piece of daemon state redirected into scratch, so the test instance can
# neither read nor rewrite the operator's real mute state, capture state, audio
# cache, lifecycle log, or voice config.
export ECHO_MUTE_STATE_PATH="${SCRATCH}/mute.json"
export ECHO_CAPTURE_STATE_PATH="${SCRATCH}/recording-state.json"
export ECHO_AUDIO_CACHE_DIR="${SCRATCH}/audio-cache"
export ECHO_AUDIO_LIFECYCLE_LOG="${SCRATCH}/audio-lifecycle.jsonl"
export ECHO_VOICE_EVENTS_LOG="${SCRATCH}/voice-events.jsonl"
export ECHO_TTS_CACHE_DIR="${SCRATCH}/tts-cache"
cp "${ROOT}/core/voices.json" "${SCRATCH}/voices.json"
export VOICES_PATH="${SCRATCH}/voices.json"

# Adapters address the daemon through this base, so both hosts under test point
# at the isolated instance rather than the default :8888.
export ECHO_DAEMON_URL="http://localhost:${PORT}"

PORT="$PORT" bun run "$ROOT/core/server.ts" >"$LOG" 2>&1 &
PID=$!
cleanup() {
  kill "$PID" >/dev/null 2>&1 || true
  wait "$PID" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

for _ in {1..40}; do
  curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.25
done

fail() { echo "FAIL: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Isolation proof — run BEFORE anything is sent, audible or not.
# ---------------------------------------------------------------------------
health="$(curl -fsS "http://localhost:${PORT}/health")" || fail "test daemon never came up (see $LOG)"
reported_port="$(echo "$health" | bun -e 'const d=JSON.parse(await Bun.stdin.text()); console.log(d.port)')"
[ "$reported_port" = "$PORT" ] || fail "daemon on :${PORT} reports port ${reported_port}"
[ "$reported_port" != "$PRODUCTION_PORT" ] || fail "resolved to the production port"
kill -0 "$PID" 2>/dev/null || fail "the daemon on :${PORT} is not the process this test started"

echo "ISOLATION CONFIRMED"
echo "  test daemon pid : ${PID} (started by this script)"
echo "  test daemon port: ${PORT}  (production is :${PRODUCTION_PORT}, untouched)"
echo "  adapter target  : ${ECHO_DAEMON_URL}"
echo "  state directory : ${SCRATCH}"

# ---------------------------------------------------------------------------
# 1. The daemon serves the persona-key contract the Claude adapter now depends on.
# ---------------------------------------------------------------------------
voices="$(curl -fsS "http://localhost:${PORT}/voices")" || fail "GET /voices not served"
echo "$voices" | bun -e '
  const body = JSON.parse(await Bun.stdin.text());
  if (!Array.isArray(body.agents)) throw new Error("GET /voices: agents is not an array");
  if (body.agents.length === 0) throw new Error("GET /voices: no agents reported");
  if (!body.default_provider) throw new Error("GET /voices: no default_provider");
  console.log(`  GET /voices -> ${body.agents.length} persona keys, provider ${body.default_provider}`);
' || fail "GET /voices returned an unusable body"

# ---------------------------------------------------------------------------
# 2. Claude Code adapter: persona keys come from the daemon over HTTP.
# ---------------------------------------------------------------------------
bun -e '
  const { fetchKnownAgentKeys } = await import(`${process.env.ROOT}/adapters/claudecode/hooks/handlers/VoiceNotification.ts`);
  const keys = await fetchKnownAgentKeys();
  if (keys.size === 0) throw new Error("Claude adapter got no persona keys from the daemon");
  if (!keys.has("themis")) throw new Error("expected the daemon-reported persona keys to include themis");
  console.log(`  claudecode adapter -> ${keys.size} persona keys via GET /voices`);
' || fail "Claude Code adapter could not read persona keys over the contract"

# ---------------------------------------------------------------------------
# 3. Pi adapter: loads with @echo/shared resolved inside its own package root,
#    and reaches the isolated daemon.
# ---------------------------------------------------------------------------
bun -e '
  const { sendNotification } = await import(`${process.env.ROOT}/adapters/pi/node_modules/@echo/shared/notify-client.ts`);
  const result = await sendNotification(
    { endpoint: `${process.env.ECHO_DAEMON_URL}/notify`, title: "Echo Test", voiceEnabled: false },
    "Echo Test engaged. Beep, boop, bop.",
    "e2e-pi",
    "e2e-session",
  );
  if (result.status !== 202) throw new Error(`expected 202 on receipt, got ${result.status}`);
  console.log("  pi adapter -> 202 accepted (silent), @echo/shared resolved in-package");
' || fail "Pi adapter could not notify the isolated daemon"

# ---------------------------------------------------------------------------
# 4. Optional audible pass — only after isolation is proven above.
# ---------------------------------------------------------------------------
if [ "$AUDIBLE" -eq 1 ]; then
  echo "  speaking on :${PORT} (test instance): \"${TEST_OPENER}\""
  code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "http://localhost:${PORT}/notify" \
    -H 'Content-Type: application/json' \
    -d "{\"message\":\"${TEST_OPENER}\",\"title\":\"Echo Test\",\"voice_enabled\":true,\"source\":\"e2e-audible\",\"session_id\":\"e2e-audible\"}")"
  [ "$code" = "202" ] || fail "audible notify returned $code"
  # The daemon acks on receipt, then synthesizes and plays on the serial queue.
  # Poll for the recorded disposition rather than guessing at a clip length.
  played=0
  for _ in {1..60}; do
    if grep -q '"disposition":"played"' "$ECHO_AUDIO_LIFECYCLE_LOG" 2>/dev/null; then
      played=1
      break
    fi
    sleep 0.5
  done
  [ "$played" = "1" ] || fail "no playback recorded in ${ECHO_AUDIO_LIFECYCLE_LOG}"
  echo "  audible line played on :${PORT}, recorded in the isolated lifecycle log"
fi

echo "OK adapter e2e passed on :${PORT} (production :${PRODUCTION_PORT} untouched)"

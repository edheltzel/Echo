#!/bin/bash
# End-to-end test of one voice-ask turn against ISOLATED daemons.
#
# Neither the operator's core daemon on :3246 nor a real coordinator on :32468 is
# touched: this script starts its own core and its own echo-converse coordinator
# on their own ports, redirects every state path into a scratch directory,
# refuses to attach to a port it does not own, and prints an isolation proof
# before sending anything.
#
# The microphone is never opened. The recorder and the transcriber are stand-in
# scripts in the scratch directory (ECHO_CONVERSE_REC_BIN / _YAP_BIN), which is
# what makes the whole turn runnable on a machine with no microphone, no yap and
# no sox - including CI, which runs Linux. What it proves is the wiring: the
# question really goes through core's /notify, playback really drains before the
# capture state flips to recording, the transcript really comes back, and the
# booking is really released afterwards.
#
#   tests/e2e-converse.sh                       # silent (default; safe anywhere)
#   tests/e2e-converse.sh --audible             # also speaks the test question
#   ECHO_E2E_PORT=8921 ECHO_E2E_CONVERSE_PORT=8922 tests/e2e-converse.sh
set -euo pipefail

export ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The real ports. The test instances must never use them.
PRODUCTION_PORT=3246
PRODUCTION_CONVERSE_PORT=32468
PORT="${ECHO_E2E_PORT:-8921}"
CONVERSE_PORT="${ECHO_E2E_CONVERSE_PORT:-8922}"
AUDIBLE=0
[ "${1:-}" = "--audible" ] && AUDIBLE=1

# The one line every spoken test says, so anything audible is unmistakably a test.
TEST_QUESTION="Echo Test engaged. Beep, boop, bop. Shall I continue?"

fail() { echo "FAIL: $*" >&2; exit 1; }

for pair in "$PORT:$PRODUCTION_PORT" "$CONVERSE_PORT:$PRODUCTION_CONVERSE_PORT" "$PORT:$PRODUCTION_CONVERSE_PORT" "$CONVERSE_PORT:$PRODUCTION_PORT"; do
  if [ "${pair%%:*}" = "${pair##*:}" ]; then
    echo "REFUSING: ${pair%%:*} is a production port." >&2
    exit 1
  fi
done

for probe in "$PORT" "$CONVERSE_PORT"; do
  if curl -fsS --max-time 2 "http://localhost:${probe}/health" >/dev/null 2>&1; then
    echo "REFUSING: something is already listening on :${probe}." >&2
    echo "This test only ever talks to processes it started itself." >&2
    exit 1
  fi
done

SCRATCH="$(mktemp -d)"
CORE_LOG="${SCRATCH}/core.log"
CONVERSE_LOG="${SCRATCH}/converse.log"

# Every piece of daemon state redirected into scratch, so neither test process
# can read or rewrite the operator's real mute state, capture state, caches,
# lifecycle log or voice config.
export ECHO_MUTE_STATE_PATH="${SCRATCH}/mute.json"
export ECHO_CAPTURE_STATE_PATH="${SCRATCH}/recording-state.json"
export ECHO_AUDIO_CACHE_DIR="${SCRATCH}/audio-cache"
export ECHO_AUDIO_LIFECYCLE_LOG="${SCRATCH}/audio-lifecycle.jsonl"
export ECHO_VOICE_EVENTS_LOG="${SCRATCH}/voice-events.jsonl"
export ECHO_TTS_CACHE_DIR="${SCRATCH}/tts-cache"
cp "${ROOT}/core/voices.json" "${SCRATCH}/voices.json"
export VOICES_PATH="${SCRATCH}/voices.json"

# Converse state, also scratch-only.
export ECHO_DAEMON_URL="http://localhost:${PORT}"
export ECHO_CONVERSE_PORT="${CONVERSE_PORT}"
export ECHO_CONVERSE_URL="http://localhost:${CONVERSE_PORT}"
export ECHO_CONVERSE_BOOKING_LOCK="${SCRATCH}/booking.lock"
export ECHO_CONVERSE_CAPTURE_DIR="${SCRATCH}/captures"
export ECHO_CONVERSE_MAX_CAPTURE_MS=4000

# Stand-in capture binaries. The recorder writes audio-shaped bytes to the WAV
# path it is given; the transcriber prints a fixed line. No microphone, no
# transcription model, no platform dependency.
TRANSCRIPT="the dev branch, please"
cat >"${SCRATCH}/fake-rec" <<'REC'
#!/bin/bash
out=""
for arg in "$@"; do case "$arg" in *.wav) out="$arg";; esac; done
[ -n "$out" ] || exit 1
head -c 8192 /dev/zero > "$out"
REC
cat >"${SCRATCH}/fake-yap" <<YAP
#!/bin/bash
echo "${TRANSCRIPT}"
YAP
chmod +x "${SCRATCH}/fake-rec" "${SCRATCH}/fake-yap"
export ECHO_CONVERSE_REC_BIN="${SCRATCH}/fake-rec"
export ECHO_CONVERSE_YAP_BIN="${SCRATCH}/fake-yap"

PORT="$PORT" bun run "$ROOT/core/server.ts" >"$CORE_LOG" 2>&1 &
CORE_PID=$!
bun run "$ROOT/converse/main.ts" >"$CONVERSE_LOG" 2>&1 &
CONVERSE_PID=$!

cleanup() {
  kill "$CORE_PID" "$CONVERSE_PID" >/dev/null 2>&1 || true
  wait "$CORE_PID" >/dev/null 2>&1 || true
  wait "$CONVERSE_PID" >/dev/null 2>&1 || true
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

for _ in {1..40}; do
  curl -fsS "http://localhost:${PORT}/health" >/dev/null 2>&1 && break
  sleep 0.25
done
for _ in {1..40}; do
  curl -fsS "http://localhost:${CONVERSE_PORT}/health" >/dev/null 2>&1 && break
  sleep 0.25
done

# ---------------------------------------------------------------------------
# Isolation proof, run BEFORE anything is sent, audible or not.
# ---------------------------------------------------------------------------
core_health="$(curl -fsS "http://localhost:${PORT}/health")" || fail "test core never came up (see $CORE_LOG)"
converse_health="$(curl -fsS "http://localhost:${CONVERSE_PORT}/health")" || fail "test coordinator never came up (see $CONVERSE_LOG)"

reported_core_port="$(echo "$core_health" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).port)')"
reported_converse_port="$(echo "$converse_health" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).port)')"
reported_capture_path="$(echo "$core_health" | bun -e 'console.log(JSON.parse(await Bun.stdin.text()).capture_guard.path)')"

[ "$reported_core_port" = "$PORT" ] || fail "core on :${PORT} reports port ${reported_core_port}"
[ "$reported_converse_port" = "$CONVERSE_PORT" ] || fail "coordinator on :${CONVERSE_PORT} reports ${reported_converse_port}"
[ "$reported_core_port" != "$PRODUCTION_PORT" ] || fail "core resolved to the production port"
[ "$reported_converse_port" != "$PRODUCTION_CONVERSE_PORT" ] || fail "coordinator resolved to the production port"
[ "$reported_capture_path" = "$ECHO_CAPTURE_STATE_PATH" ] || fail "core reads ${reported_capture_path}, not the scratch capture state"
kill -0 "$CORE_PID" 2>/dev/null || fail "the core on :${PORT} is not the process this test started"
kill -0 "$CONVERSE_PID" 2>/dev/null || fail "the coordinator on :${CONVERSE_PORT} is not the process this test started"

echo "ISOLATION CONFIRMED"
echo "  core pid/port        : ${CORE_PID} / ${PORT}  (production is :${PRODUCTION_PORT}, untouched)"
echo "  coordinator pid/port : ${CONVERSE_PID} / ${CONVERSE_PORT}  (production is :${PRODUCTION_CONVERSE_PORT}, untouched)"
echo "  capture state file   : ${reported_capture_path}"
echo "  recorder/transcriber : stand-ins in ${SCRATCH} (no microphone is opened)"

# ---------------------------------------------------------------------------
# 1. The coordinator reports itself microphone-free and unbooked.
# ---------------------------------------------------------------------------
echo "$converse_health" | bun -e '
  const body = JSON.parse(await Bun.stdin.text());
  if (body.capability !== "echo-converse") throw new Error(`unexpected capability ${body.capability}`);
  if (body.capture.owner !== "caller") throw new Error("the coordinator claims to own capture");
  if (body.booking.held) throw new Error("the microphone is booked before any ask");
  console.log(`  GET /health -> ${body.capability}, capture owner: ${body.capture.owner}`);
' || fail "coordinator /health returned an unusable body"

# ---------------------------------------------------------------------------
# 2. One full turn: question through core, reply captured, transcript returned.
# ---------------------------------------------------------------------------
VOICE_ENABLED=0
[ "$AUDIBLE" -eq 1 ] && VOICE_ENABLED=1
export VOICE_ENABLED TEST_QUESTION TRANSCRIPT

bun -e '
  const { askOnce } = await import(`${process.env.ROOT}/converse/client.ts`);
  const { readCaptureState } = await import(`${process.env.ROOT}/core/capture-guard.ts`);
  const { resolveConverseConfig } = await import(`${process.env.ROOT}/converse/config.ts`);
  const capturePath = process.env.ECHO_CAPTURE_STATE_PATH;

  const config = resolveConverseConfig(process.env);
  const seenDuringCapture = [];
  const engine = process.env.VOICE_ENABLED === "1"
    ? undefined
    : undefined; // the stand-in binaries are the engine; nothing is injected here

  const result = await askOnce(
    { question: process.env.TEST_QUESTION, source: "e2e-converse" },
    { config, captureEngine: async (cfg, signal) => {
        // Observe the interlock from inside the capture window, then delegate to
        // the real engine so the recorder and transcriber subprocesses run.
        seenDuringCapture.push(readCaptureState(capturePath, () => true));
        const { captureAndTranscribe } = await import(`${process.env.ROOT}/converse/capture.ts`);
        return captureAndTranscribe(cfg, signal);
      } },
  );

  if (result.text !== process.env.TRANSCRIPT) {
    throw new Error(`expected the transcript ${JSON.stringify(process.env.TRANSCRIPT)}, got ${JSON.stringify(result.text)}`);
  }
  if (!result.spoke.drained) throw new Error("capture was granted before playback drained");
  if (seenDuringCapture[0] !== "recording") {
    throw new Error(`core saw capture state ${seenDuringCapture[0]} while the microphone was open`);
  }
  if (readCaptureState(capturePath, () => true) !== "idle") {
    throw new Error("the capture state did not return to idle after the turn");
  }
  if (result.ancestry.length === 0) throw new Error("no process ancestry was recorded for the capture");

  console.log(`  POST /turn -> spoke in ${result.spoke.waited_ms}ms (${result.spoke.polls} poll(s)), engine ${result.engine}`);
  console.log(`  transcript -> ${JSON.stringify(result.text)}`);
  console.log(`  capture ancestry -> ${result.ancestry.slice(0, 3).join(" <- ")}`);
' || fail "the one-shot ask did not complete"

# ---------------------------------------------------------------------------
# 3. The question really went through core's own /notify pipeline.
# ---------------------------------------------------------------------------
grep -q "Notification accepted" "$CORE_LOG" || fail "core never accepted the question notification"
echo "  core log -> question accepted through POST /notify"

# ---------------------------------------------------------------------------
# 4. The booking is released, and a second ask can proceed.
# ---------------------------------------------------------------------------
[ ! -e "$ECHO_CONVERSE_BOOKING_LOCK" ] || fail "the booking lock survived a completed turn"
after="$(curl -fsS "http://localhost:${CONVERSE_PORT}/health")"
echo "$after" | bun -e '
  const body = JSON.parse(await Bun.stdin.text());
  if (body.booking.held) throw new Error("the microphone is still booked after the turn");
  if (body.turns.completed !== 1) throw new Error(`expected 1 completed turn, got ${body.turns.completed}`);
  console.log(`  GET /health -> ${body.turns.completed} completed turn, microphone free`);
' || fail "the coordinator did not release the booking"

# ---------------------------------------------------------------------------
# 5. A concurrent ask is refused rather than opening a second microphone.
# ---------------------------------------------------------------------------
bun -e '
  const { resolveConverseConfig } = await import(`${process.env.ROOT}/converse/config.ts`);
  const config = resolveConverseConfig(process.env);
  const body = (question) => JSON.stringify({
    question, owner_pid: process.pid, source: "e2e-converse", lease_ms: 30000,
  });
  const post = (question) => fetch(`${config.baseUrl}/turn`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: body(question),
  });

  const [first, second] = await Promise.all([post("First question?"), post("Second question?")]);
  const responses = [first, second];

  // Exactly one ask may hold the booking. The winner may still fail later in the
  // turn: by this point the script has spent several requests against core, and
  // core rate-limits one client to ten a minute across /notify and /health. That
  // is a real property of the capability (see docs/converse.md), so the winner
  // may come back 200 or 503 - what must never happen is two winners.
  const refused = responses.filter((response) => response.status === 409);
  const admitted = responses.filter((response) => response.status !== 409);
  if (refused.length !== 1 || admitted.length !== 1) {
    throw new Error(`expected exactly one 409, got ${responses.map((r) => r.status).join(" and ")}`);
  }

  const refusedBody = await refused[0].json();
  if (refusedBody.error !== "microphone_busy") throw new Error(`expected microphone_busy, got ${refusedBody.error}`);

  const admittedBody = await admitted[0].json();
  if (admitted[0].status === 200) {
    // Hand the microphone back so the scratch state ends clean.
    await fetch(`${config.baseUrl}/turn/${admittedBody.turn_id}/abort`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "concurrency check" }),
    });
  } else if (admittedBody.error === undefined) {
    throw new Error(`the admitted ask failed without naming a reason: HTTP ${admitted[0].status}`);
  }
  const outcome = admitted[0].status === 200 ? "granted" : `admitted then ${admittedBody.error}`;
  console.log(`  two simultaneous asks -> one ${outcome}, one ${refusedBody.error}`);
' || fail "concurrent asks were not serialized"

# ---------------------------------------------------------------------------
# 6. A stale booking owner is reaped instead of deadlocking every later ask.
# ---------------------------------------------------------------------------
bun -e '
  const { writeFileSync } = await import("node:fs");
  const { resolveConverseConfig } = await import(`${process.env.ROOT}/converse/config.ts`);
  const config = resolveConverseConfig(process.env);

  // A crashed ask: a live-looking lease owned by a pid that no longer exists.
  const dead = Bun.spawnSync(["true"]);
  writeFileSync(config.bookingLockPath, JSON.stringify({
    turn_id: "crashed-turn", owner_pid: 999999, source: "e2e-crash",
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 600000).toISOString(),
  }));

  const response = await fetch(`${config.baseUrl}/turn`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Recovered?", owner_pid: process.pid, source: "e2e-converse", lease_ms: 30000 }),
  });
  const body = await response.json();

  // What must not happen is 409: that would mean the dead owner still holds the
  // microphone. Any other refusal is a later step of the turn (the shared
  // rate-limit budget of core, by this point in the script), which means the
  // lock was taken and released rather than deadlocked.
  if (response.status === 409) {
    throw new Error(`a dead booking owner deadlocked the microphone: ${body.error}`);
  }
  if (response.status === 200) {
    await fetch(`${config.baseUrl}/turn/${body.turn_id}/abort`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "reaping check" }),
    });
  }
  const { readBooking } = await import(`${process.env.ROOT}/converse/booking.ts`);
  if (readBooking(config.bookingLockPath) !== null) {
    throw new Error("the reaped booking was not released");
  }
  console.log(`  crashed booking owner -> reaped (HTTP ${response.status}), microphone recovered`);
' || fail "a stale booking owner was not reaped"

echo
echo "PASS: one-shot voice ask end to end (core :${PORT}, coordinator :${CONVERSE_PORT})"
if [ "$AUDIBLE" -eq 0 ]; then
  echo "      silent run; pass --audible to hear the question spoken"
fi

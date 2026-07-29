# echo-converse: the one-shot voice ask

Echo speaks. `echo-converse` lets it ask. One question out loud, one spoken reply captured,
one transcript returned to the calling agent. Local transcription, no cloud rung, no
conversational loop in v1.

```bash
bun converse/main.ts                       # start the coordinator on :32468
curl -fsS http://localhost:32468/health    # capability, booking state, core address
bash scripts/install.sh --adapter mcp      # register the tool for Claude Code
tests/e2e-converse.sh                      # isolated end-to-end turn, no microphone needed
```

Hosts do not call the HTTP surface directly. Pi and omp register an `echo_ask` tool inside
their existing adapters; Claude Code consumes the same tool through `adapters/mcp/`. All three
route to one place: `askOnce` in `converse/client.ts`.

## Why capture lives in the caller, not the daemon

This is the load-bearing design decision, and it is not a preference. macOS gates microphone
access through TCC, which attributes a request to the **responsible process**. A spike on this
host (macOS 26.5.2, report retained with the Themis task data) measured both topologies:

| Topology | TCC result |
|---|---|
| host terminal → on-demand `yap`/`rec` child | responsible process `com.github.wez.wezterm`, accessing process `yap`; live audio (89,119 bytes of PCM in three seconds) |
| user launchd job → `yap`/`rec` | no responsible process, repeated "Failed to fetch responsible file descriptor", no grant created, job exited (status 64 / 1) |

So an always-on service cannot own the microphone: it gets no prompt surface, no grant, and no
audio. The capability is split accordingly.

- **The coordinator** (`converse/server.ts`, port **32468**, keypad ECHOV) books the microphone,
  speaks the question through core and watches playback drain. It never opens the microphone,
  and it never spawns a subprocess at all. Both properties are enforced by
  `tests/converse/architecture-invariants.test.ts`, not just documented.
- **The caller** (`converse/client.ts`, running inside the Pi extension, the omp extension or
  the MCP server) spawns the capture child per ask, so the recorder inherits the host terminal's
  process ancestry. Each turn records the resolved ancestry chain, so the attribution claim is
  something an operator can read back rather than assume.

There is deliberately **no LaunchAgent** for this capability. The coordinator starts on demand
(`ensureCoordinator`) and its lifetime tracks actual use.

The consequence to know: **the human grants microphone access to their terminal application**
(WezTerm, iTerm, Ghostty, Terminal), not to `yap`, `rec` or any echo process. If a future
product requirement forbids terminal-attributed capture, the alternative is a signed GUI parent
with a microphone usage description, which is a separate architecture decision.

## The turn

```
 host tool call
      |
      v
 POST /turn ------------------> coordinator:32468
                                  1. book the microphone (atomic lock)
                                  2. GET core /health   (preflight)
                                  3. POST core /notify  (speak the question)
                                  4. GET core /health   (wait for the queue to drain)
      <----------------------- 200 { turn_id, capture_state_path, spoke, lease }
      |
      | caller writes capture state = recording   <-- only now
      | caller spawns the capture child (rec -> wav -> yap/whisper)
      | caller writes capture state = idle        <-- always, in a finally
      v
 POST /turn/<id>/complete ----> booking released
```

**Core is untouched.** It stays on `:3246`, keeps its `/notify` contract, gains no endpoint and
gains no microphone. The question rides the existing provider chain, cache and play queue.

**The self-hold trap.** Core already reads a capture-state file and goes silent while some other
tool holds the microphone (`core/capture-guard.ts`). Converse becomes the writer of that same
file, which turns the arbitration core already ships into the interlock a conversation needs.
Ordering is therefore not optional: the question is spoken while the state is idle, the state
flips to `recording` only after playback drains, or core would hold back the very question it
was asked to speak. `withCaptureHeld` expresses that in code, and the test in
`tests/converse/ask.test.ts` reads the state file at the moment core is asked to speak.

**The writer publishes its own pid.** Core honors a non-idle state only while that pid is alive,
so the capture owner writes its own, and a crashed host frees core immediately instead of
leaving the operator silently muted. `tests/converse/capture-state-contract.test.ts` proves the
format agreement by writing with converse and reading with core.

**One microphone, one human, N agents.** The booking lock is created with `wx`, so the
filesystem picks the winner rather than a check-then-act race. A holder counts only while its
owner process is alive and its lease is unexpired; anything else is reaped, because a crashed
ask must not wedge every later one. A concurrent ask gets `409` rather than an invisible queue.

## Endpoints (`:32468`)

| Route | Meaning |
|---|---|
| `POST /turn` | Book, speak, wait for drain. `200` grants capture and returns `capture_state_path`, `spoke`, `lease`. |
| `POST /turn/:id/complete` | Release the booking. Body is metadata only (`engine`, `capture_ms`, `transcript_chars`). |
| `POST /turn/:id/abort` | Release the booking and record why. |
| `GET /health` | Capability, port, booking holder, turn counters, configured core address. Does not probe core. |

Refusals name their reason: `400 invalid_request`, `409 microphone_busy`,
`503 core_unreachable | core_rate_limited | core_muted | capture_guard_disabled | question_not_spoken`,
`404 unknown_turn`. Every refusal releases the booking.

**The transcript never reaches the coordinator.** `/turn/:id/complete` carries a character count,
not the text; the recording itself is deleted as soon as it is transcribed. The audio and the
words stay in the process that captured them.

## The capture pipeline

| Stage | What runs |
|---|---|
| Speak | core `POST /notify` (whole existing TTS chain) |
| Capture | `rec` (sox) with the `silence` effect for endpointing, at the device's native rate |
| Tier 1 transcribe | `yap transcribe` - Apple SpeechAnalyzer, on-device, no model download |
| Tier 2 transcribe | `whisper-cli` - portable, needs a user-supplied ggml model (`ECHO_CONVERSE_WHISPER_MODEL`) |
| Polish | none. The raw transcript is returned; the calling agent interprets it. |

**This splits the scoping plan's Tier 1 row, which assigned "capture + endpoint" to
`yap dictate`.** Installed `yap` 1.2.1 has no duration, silence or stop flag: `dictate` streams
until it is killed, so it cannot end a turn. `rec` can, the spike already proved it captures
from this ancestry, and `yap transcribe` remains the Tier 1 transcriber (verified: 0.74s, exact
transcript on synthesized speech). The cost of the change is that **`sox` is a Tier 1
dependency**, where the plan had it only in Tier 2.

Capture stays at the device's native rate on purpose: VoiceLayer's documented lesson is that
resampling inside the streaming path overruns on devices at unusual rates (AirPods at 24kHz), so
the 16kHz conversion whisper needs happens offline afterwards, where an overrun is impossible.

No speech is a distinct outcome: sox writes a 44-byte header-only file when the endpointer hears
nothing, and an empty transcript is reported as `no_speech` rather than as an empty answer.

## Known limits in v1

- **An ask costs four to six requests against core.** Core rate-limits one client to ten
  requests a minute, shared between `/notify` and `/health`, and the drain wait is `/health`
  polling. So asks are for occasional questions, not tight loops; asking twice inside a minute
  can come back `core_rate_limited`. Making this cheap needs a per-request completion signal from
  `/notify`, which would change core's contract, and that is deliberately deferred.
- **A question dropped by the play queue's age cap is indistinguishable from one that played.**
  Same root cause, same deferred fix. The wait is bounded and its outcome is reported in `spoke`.
- Out of scope for v1: barge-in, a transcript-polish model, cloned voices, waveform streaming,
  non-macOS targets, and any multi-turn session.

## Configuration

Resolved through `shared/echo-env.ts` like everything else: live process values win, then
`~/.config/echo/config.json`, then a legacy dotenv file. See
[configuration.md](configuration.md) for the full key list.

| Key | Default | Read by |
|---|---|---|
| `ECHO_CONVERSE_PORT` | `32468` | coordinator |
| `ECHO_CONVERSE_URL` | `http://localhost:32468` | callers |
| `ECHO_CONVERSE_BOOKING_LOCK` | `~/.local/state/echo/converse/booking.lock` | coordinator |
| `ECHO_CONVERSE_LEASE_MS` | `120000` | coordinator |
| `ECHO_CONVERSE_CAPTURE_DIR` | `~/Library/Caches/echo/converse` | caller |
| `ECHO_CONVERSE_MAX_CAPTURE_MS` | `30000` | caller |
| `ECHO_CONVERSE_SILENCE_MS` | `1500` | caller |
| `ECHO_CONVERSE_LOCALE` | `en-US` | caller |
| `ECHO_CONVERSE_STT_TIER` | auto (`yap`, else `whisper`) | caller |
| `ECHO_CONVERSE_REC_BIN` / `_SOX_BIN` / `_YAP_BIN` / `_WHISPER_BIN` | on `PATH` | caller |
| `ECHO_CONVERSE_WHISPER_MODEL` | unset | caller |

An explicitly configured tier is never silently swapped for the other: a missing binary reports
itself instead of transcribing through a rung nobody chose.

## Testing

Never point a test at the running daemon or a real coordinator. `tests/e2e-converse.sh` starts
both processes itself on isolated ports, redirects every state path to scratch, refuses to
attach to a port it does not own, and prints an isolation proof first. Its recorder and
transcriber are stand-in scripts, so the whole turn runs with no microphone and no platform
audio tooling. `bun test` covers the booking lock, the capture-state contract against core's own
reader, the self-hold ordering, the endpoint contract, the capture subprocess handling, the
adapters' tool registration and the MCP wire protocol.

## Related

- [adapters.md](adapters.md) - adapter boundary and the reconcile-and-prune registration contract
- [http-api.md](http-api.md) - core's `/notify` and `/health`, which converse consumes
- [../ARCHITECTURE.md](../ARCHITECTURE.md) - where this sits in the tree
- [plans/2026-07-13-voiceask-scoping.md](plans/2026-07-13-voiceask-scoping.md) - the validated
  scoping this was built from. Its provisional `:8890` is superseded by `32468`.

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
  speaks the question through core and waits for core's verdict on it. It opens no microphone and
  spawns no subprocess.
- **The caller** (`converse/client.ts`, running inside the Pi extension, the omp extension or
  the MCP server) spawns the capture child per ask, so the recorder runs in the host's process
  tree.

**How strongly those two properties hold, precisely.** An earlier version of this document called
them "mechanically enforced". That was an overclaim, a reviewer rejected it, and it is the reason
PR #136 was held. What actually exists:

| Property | What holds it | What that does not cover |
|---|---|---|
| The coordinator opens no microphone | `tests/converse/architecture-invariants.test.ts` source-scans coordinator-reachable code and fails on a capture-module import or ANY subprocess spawn | A source scan, not a runtime assertion. A dynamic import, a dependency that spawns on its own, or an unrecognised helper would pass it. |
| Capture runs in the caller's process tree | Construction: the capture child is spawned by `converse/client.ts` inside the host process | Nothing asserts it at runtime. There is no cheap check: `Bun.spawn` makes the client the parent by definition, so comparing them would always agree and prove nothing. |
| The grant attributes to the terminal app | The TCC spike measured it for a terminal-spawned child | Measured for a shell-spawned recorder on one host. See the unverified link below. |

Each turn records the process ancestry it resolved and the pid that ran the recorder. That is
evidence an operator can correlate with a TCC log entry, not proof of attribution.

One link in that chain is expected rather than measured. For Pi and omp the capture child is a
descendant of the host process itself, which is the shape the spike measured. For Claude Code the
capture child descends from the stdio MCP server the host spawns, so the ancestry should reach the
terminal the same way, but no run on this host has confirmed it end to end. Every turn records the
ancestry it resolved (`GET /turn` response and the turn log), so the first real ask through Claude
Code reports the answer instead of assuming it.

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
 caller writes capture state = recording + nonce   <-- BEFORE asking
      |
      v
 POST /turn ------------------> coordinator:32468
                                  1. book the microphone (atomic lock)
                                  2. GET core /health   (preflight: mute, path, holder)
                                  3. POST core /notify  (question + nonce + await_playback)
                                     ... core answers when THIS line is finished
      <----------------------- 200 { turn_id, spoke: { disposition: "played" }, lease }
      |
      | caller spawns the capture child (rec -> wav -> yap/whisper)
      | caller writes capture state = idle   <-- always attempted in a finally,
      |                                          written only if the record is still ours
      v
 POST /turn/<id>/complete ----> booking released
```

**Core is touched, minimally and additively.** The original plan said core would not change at
all, and for the first version it did not. A red team then showed that polling shared `/health`
cannot prove a particular question finished: queue depth is global, so an idle reading cannot
distinguish "my line is done" from "my line has not started", and another session's audio can
begin in the gap before the microphone opens. There is no sound fix without a real completion
signal, so `/notify` gained two optional fields:

| Field | Effect | Absent |
|---|---|---|
| `await_playback: true` | The response is held until that line reaches a terminal disposition and answers `200` with it | `202` on receipt, exactly as before |
| `capture_bypass_nonce` | Speaks this one line despite an active capture hold, when it matches the secret in the hold's own file | Held by the guard, exactly as before |

Core gains no endpoint, no microphone, and no change for any caller that omits both fields. It
still stays on `:3246`. `GET /health` also reports `capture_guard.pid` so a coordinator can tell
its own caller's hold from a foreign tool's recording.

**The self-hold trap.** Core already reads a capture-state file and goes silent while some other
tool holds the microphone (`core/capture-guard.ts`). Converse becomes the writer of that same
file, which turns the arbitration core already ships into the interlock a conversation needs.
Ordering is therefore not optional, and it now runs the other way round. The hold goes up
BEFORE the question is asked, which is what leaves no gap between "the question finished" and
"the microphone opened" for another session's audio. The question stays audible because it
carries the owner nonce from that same file, which is core's proof that the line belongs to the
process holding the microphone. Get the pairing wrong and core silences the very question it was
asked to speak, so `tests/converse/interlock.test.ts` asserts both halves: the hold IS published
when core receives the question, and the nonce accompanies it.

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
| `POST /turn` | Book, speak, and wait for core's verdict on the question. `200` grants capture and returns `spoke.disposition`, `capture_state_path`, `lease`. Takes the caller's `capture_state_path` and `capture_nonce`. |
| `POST /turn/:id/complete` | Release the booking. Body is metadata only (`engine`, `capture_ms`, `transcript_chars`). |
| `POST /turn/:id/abort` | Release the booking and record why. |
| `GET /health` | Capability, port, booking holder, turn counters, configured core address. Does not probe core. |

Refusals name their reason: `400 invalid_request`, `409 microphone_busy`,
`503 core_unreachable | core_rate_limited | core_muted | capture_guard_disabled | question_not_spoken`,
`404 unknown_turn`. Every refusal releases the booking, `404 unknown_turn` included: the turn
table is in memory and the booking is on disk, so a caller whose turn the coordinator no longer
remembers is still the one who has to hand the microphone back.

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
The Tier 1 rung needs no conversion at all, which was checked rather than assumed: this host
records at 48kHz, and `yap transcribe` returns the phrase from a 48kHz file. Only whisper.cpp
requires 16kHz mono, so only that rung pays for the resample.

Both binaries are checked for existence before a turn spawns anything, so a machine with `yap`
but no `sox` gets "install sox (`brew install sox`), which provides `rec`" rather than an ENOENT
from inside a turn. That case is worth naming because splitting the Tier 1 row is what created
it: `sox` is now a Tier 1 dependency.

No speech is a distinct outcome: sox writes a 44-byte header-only file when the endpointer hears
nothing, and an empty transcript is reported as `no_speech` rather than as an empty answer.

## Known limits in v1

- **An ask costs two requests against core**, one preflight `/health` and one `/notify` whose
  response is the completion signal. Core rate-limits one client to ten requests a minute shared
  across both, so several asks a minute are fine and a burst can still come back
  `core_rate_limited`. The earlier four-to-six range came from drain polling, which is gone.
- **A held-open `/notify` occupies a request for the length of the question.** It is bounded by
  the play queue's own watchdog plus a margin, and a timeout answers with the disposition rather
  than hanging.
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
| `ECHO_CONVERSE_CAPTURE_DIR` | `~/Library/Caches/echo/converse` | caller |
| `ECHO_CONVERSE_MAX_CAPTURE_MS` | `30000` | caller |
| `ECHO_CONVERSE_SILENCE_MS` | `1500` | caller |
| `ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS` | `60000` | caller |
| `ECHO_CONVERSE_LOCALE` | `en-US` | caller |
| `ECHO_CONVERSE_STT_TIER` | auto (`yap`, else `whisper`) | caller |
| `ECHO_CONVERSE_REC_BIN` / `_SOX_BIN` / `_YAP_BIN` / `_WHISPER_BIN` | on `PATH` | caller |
| `ECHO_CONVERSE_WHISPER_MODEL` | unset | caller |

An explicitly configured tier is never silently swapped for the other: a missing binary reports
itself instead of transcribing through a rung nobody chose.

Every subprocess is capped, not just the recorder. The capture state stays non-idle for the whole
turn and core skips every voice line while it is, so a wedged transcriber would otherwise mute
Echo for as long as the calling host lives. A turn has exactly two caps: the recorder gets
`ECHO_CONVERSE_MAX_CAPTURE_MS`, and the whole transcription phase shares one
`ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS` budget, so the whisper tier's resample and its
transcriber draw from the same clock rather than getting a cap each. A turn's lease is those two
caps plus slack, and it is measured from the GRANT rather than from the request, so a
slow-but-healthy transcription cannot outlive its own booking. There is no lease knob on purpose:
the lease is derived from the caps on the work it protects, and a knob that let an operator set it
shorter than that operation would reintroduce exactly the expiry-mid-capture bug it replaced.

The speak phase is deliberately outside that budget. The microphone is not open while the question
plays, and that phase has its own bound in core (the play queue's watchdog plus a margin), so a
question queued behind other lines cannot eat the capture budget before recording starts.

The recorder is stopped with SIGTERM only, because sox has to catch the signal to finalize the
WAV header. A transcriber has no header to finalize, so its cap escalates to SIGKILL after a
short grace and is therefore hard rather than advisory.

Cancelling an ask (the host aborts the tool call) never strands the microphone. `POST /turn` is
deliberately not cancellable: aborting it would reject before the grant arrived, leaving a
booking whose `turn_id` the caller never learned. A cancel that lands while the question is being
spoken is honored as soon as the grant arrives, by aborting the turn instead of opening the
microphone; a cancel during capture reaches the recorder directly and the same release path runs.

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

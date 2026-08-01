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
| --- | --- |
| host terminal → on-demand `yap`/`rec` child | responsible process `com.github.wez.wezterm`, accessing process `yap`; live audio (89,119 bytes of PCM in three seconds) |
| user launchd job → `yap`/`rec` | no responsible process, repeated "Failed to fetch responsible file descriptor", no grant created, job exited (status 64 / 1) |

So an always-on service cannot own the microphone: it gets no prompt surface, no grant, and no
audio. The capability is split accordingly.

- **The coordinator** (`converse/server.ts`, port **32468**, keypad ECHOV) books the microphone,
  speaks the question through core and waits for that request's exact playback completion plus a
  capture reservation. It never opens the microphone,
  and it never spawns a subprocess at all. `tests/converse/architecture-invariants.test.ts`
  provides source-level regression checks for those boundaries; it is not runtime process
  enforcement.
- **The caller** (`converse/client.ts`, running inside the Pi extension, the omp extension or
  the MCP server) spawns the capture child under that adapter process. The measured direct Pi/omp
  shape reaches the terminal; the Claude MCP path remains the unverified case below. Each turn
  retains the resolved ancestry chain as evidence, but the coordinator does not enforce it.

One link in that chain is expected rather than measured. For Pi and omp the capture child is a
descendant of the host process itself, which is the shape the spike measured. For Claude Code the
capture child descends from the stdio MCP server the host spawns, so the ancestry should reach the
terminal the same way, but the Claude Code bridge path is unverified on this host. Every turn
retains the ancestry it resolved in the caller result and coordinator's active-turn record, so a
real ask through Claude Code preserves observed evidence instead of turning the expectation into
a guarantee.

There is deliberately **no LaunchAgent** for this capability. The coordinator starts on demand
(`ensureCoordinator`) and its lifetime tracks actual use.

For the measured direct-terminal topology, the human grants microphone access to the terminal
application (WezTerm, iTerm, Ghostty, Terminal), not to `yap`, `rec` or Echo's coordinator. Pi and
omp use that shape. Claude Code remains the explicit unverified case above. If the product later
requires a separately attributed capture parent, that would need a signed GUI helper with a
microphone usage description and is a separate architecture decision.

## The turn

```
 host tool call
      |
      v
 POST /turn ------------------> coordinator:32468
                                  1. book the microphone (atomic lock)
                                  2. GET core /health   (preflight)
                                  3. POST core /notify  (speak; opt-in reservation)
                                  4. GET core /notify/<id>/completion
                                     (wait for this line; reservation blocks playback)
                                  5. POST core /notify/capture-reservations/<turn>/grant
                                     (start core + booking leases at capture grant)
      <----------------------- 200 { turn_id, capture_state_path, spoke, lease }
      |
      | caller writes capture state = recording   <-- only now
      | caller spawns the capture child (rec -> wav -> yap/whisper)
      | caller writes capture state = idle        <-- always, in a finally
      v
 POST /turn/<id>/complete ----> booking released
```

**Core changes are additive and opt-in.** It stays on `:3246` and keeps the existing receipt-based
`/notify` response for ordinary callers. Converse adds a `capture_reservation` request field and
uses per-request completion plus grant/release routes. The reservation id is the coordinator's
turn id, known before `/notify`; if core accepts the request but its response is lost, the
coordinator can still release that id. A release arriving before acceptance leaves a bounded
cancellation tombstone, so the late request cannot activate a leaked reservation. The question
still rides the existing provider chain, cache and play queue, and core never opens the microphone.

**The self-hold trap.** Core already reads a capture-state file and goes silent while some other
tool holds the microphone (`core/capture-guard.ts`). Converse becomes the writer of that same
file, which turns the arbitration core already ships into the interlock a conversation needs.
Ordering is therefore not optional: the question is spoken while the state is idle, and the state
flips to `recording` only after this request completes and core holds the reservation. Otherwise
core would hold back the very question it was asked to speak. `withCaptureHeld` expresses that in
code, and the test in
`tests/converse/ask.test.ts` reads the state file at the moment core is asked to speak.

**The writer publishes its own pid.** Core honors a non-idle state only while that pid is alive,
so the capture owner writes its own, and a crashed host frees core immediately instead of
leaving the operator silently muted. `tests/converse/capture-state-contract.test.ts` proves the
format agreement by writing with converse and reading with core.

**One microphone, one human, N agents.** The booking lock is created with `wx`, so the
filesystem picks the winner rather than a check-then-act race. A holder counts only while its
owner process is alive and its lease is unexpired; anything else is reaped, because a crashed
ask must not wedge every later one. A concurrent ask gets `409` rather than an invisible queue.
`tests/converse/multiprocess-interlock.test.ts` races two real host processes through this path:
only the filesystem-selected winner publishes capture, and only its core reservation is granted.

## Endpoints (`:32468`)

| Route | Meaning |
| --- | --- |
| `POST /turn` | Book, speak, wait for this request's completion/reservation. `200` grants capture and returns `capture_state_path`, `spoke`, `lease`. |
| `POST /turn/:id/complete` | Release the booking. Body is metadata only (`engine`, `capture_ms`, `transcript_chars`). |
| `POST /turn/:id/abort` | Release the booking and record why. |
| `GET /health` | Capability, port, booking holder, turn counters, configured core address. Does not probe core. |

Refusals name their reason: `400 invalid_request | lease_too_short | lease_unsupported`,
`409 microphone_busy`, `503 core_unreachable | core_rate_limited | core_muted |
capture_guard_disabled | question_not_spoken`,
`404 unknown_turn`, `500 coordinator_error` (an unexpected failure before the booking was
taken). Every refusal releases the booking, `404 unknown_turn` included: the turn
table is in memory and the booking is on disk, so a caller whose turn the coordinator no longer
remembers is still the one who has to hand the microphone back.

**The transcript never reaches the coordinator.** `/turn/:id/complete` carries a character count,
not the text; the recording itself is deleted as soon as it is transcribed. The audio and the
words stay in the process that captured them.

## The capture pipeline

| Stage | What runs |
| --- | --- |
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

- **An ask still spends multiple core requests.** It preflights, submits one opt-in `/notify`,
  polls that request's completion, and releases the reservation at the end. Completion/status
  reads have their own rate-limit bucket, but asks remain for occasional questions rather than
  tight loops.
- **The coordinator reports only the core completion outcome.** A successful completed state is
  exact for the request it submitted; provider playback details remain in core's lifecycle log.
- Out of scope for v1: barge-in, a transcript-polish model, cloned voices, waveform streaming,
  non-macOS targets, and any multi-turn session.

## Configuration

Set these properties in `~/.config/echo/config.json`. That file wins; process and legacy
dotenv values remain one-release warning fallbacks. See [configuration.md](configuration.md)
for the complete precedence and migration contract.

| Key | Default | Read by |
| --- | --- | --- |
| `ECHO_CONVERSE_PORT` | `32468` | coordinator |
| `ECHO_CONVERSE_URL` | `http://localhost:32468` | callers |
| `ECHO_CONVERSE_BOOKING_LOCK` | `~/.local/state/echo/converse/booking.lock` | coordinator |
| `ECHO_CONVERSE_LEASE_MS` | capture + transcription budget plus slack (`120000` at the defaults) | coordinator |
| `ECHO_CONVERSE_LOG_PATH` | `~/Library/Logs/echo-converse.log` | auto-start caller |
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
caps plus slack, and that is also where the `ECHO_CONVERSE_LEASE_MS` default comes from, so
raising either cap cannot leave the default lease below the budget it is checked against. The
coordinator refuses a lease below the operation budget or above the maximum it can honor rather
than silently clamping it. Both the booking and core reservation are rebased
at the capture grant, so question playback does not consume the protected capture interval.

The recorder is stopped with SIGTERM only, because sox has to catch the signal to finalize the
WAV header. A transcriber has no header to finalize, so its cap escalates to SIGKILL after a
short grace and is therefore hard rather than advisory.

Cancelling an ask (the host aborts the tool call) never strands the microphone. `POST /turn` is
deliberately not cancellable: aborting it would reject before the grant arrived, leaving a
booking whose `turn_id` the caller never learned. A cancel that lands while the question is being
spoken is honored as soon as the grant arrives, by aborting the turn instead of opening the
microphone; a cancel during capture reaches the recorder directly and the same release path runs.
Cancellation is checked again after transcription and after completion bookkeeping, so no
post-cancel transcript can be returned.

## Testing

Never point a test at the running daemon or a real coordinator. `tests/e2e-converse.sh` starts
both processes itself on isolated ports, redirects every state path to scratch, refuses to
attach to a port it does not own, and prints an isolation proof first. Its recorder and
transcriber are stand-in scripts, so the whole turn runs with no microphone and no platform
audio tooling. `bun test` covers the booking lock, the capture-state contract against core's own
reader, the self-hold ordering, a real two-process booking race, the endpoint contract, the
capture subprocess handling, the adapters' tool registration and the MCP wire protocol.

## Related

- [adapters.md](adapters.md) - adapter boundary and the reconcile-and-prune registration contract
- [http-api.md](http-api.md) - core's `/notify` and `/health`, which converse consumes
- [../ARCHITECTURE.md](../ARCHITECTURE.md) - where this sits in the tree
- [plans/archive/2026-07-13-voiceask-scoping.md](plans/archive/2026-07-13-voiceask-scoping.md) - the validated
  scoping this was built from. Its provisional `:8890` is superseded by `32468`.

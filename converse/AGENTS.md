# AGENTS.md

## Purpose

`converse/` is the `@echo/converse` workspace package: the one-shot voice ask. It owns the three
concerns Echo's TTS daemon has never had - microphone capture, a local speech-to-text
dependency, and a blocking request/response turn - without changing `core/`.

Full design, the TCC evidence behind the process topology, the endpoint contract and the known
v1 limits: **[../docs/converse.md](../docs/converse.md)**.

## Ownership

- **Coordinator side** (`server.ts`, `main.ts`, `booking.ts`, `playback.ts`, `config.ts`,
  `types.ts`): books the microphone and speaks the question through core, which answers once that
  line has finished playing (`await_playback`).
- **Caller side** (`client.ts`, `capture.ts`, `capture-state.ts`, `host-tool.ts`): opens the
  microphone, transcribes locally, publishes capture state, and exposes `echo_ask` to hosts.
- Host wiring lives in `adapters/*`, never here. This package knows nothing about Pi, omp or
  Claude Code beyond the `source` tag a caller passes.

## Local Contracts

- **The coordinator never opens the microphone and never spawns a subprocess.** macOS gives a
  background process no TCC responsible process, no prompt surface and no grant, so capture must
  happen in the calling host's own process tree. `../tests/converse/architecture-invariants.test.ts`
  holds this with a **source scan**, not runtime enforcement: it fails on an import of a capture
  module or any subprocess spawn in coordinator-reachable code, which catches the regressions
  people write, and it cannot see a dynamic import or a dependency that spawns on its own. Do not
  describe it as mechanically guaranteed; that overclaim is what held PR #136.
- **Publish the hold first, then ask.** The capture state flips to `recording` BEFORE the
  question is spoken, which is what leaves no gap between the question ending and the microphone
  opening for another session's audio. The question stays audible because it carries the per-turn
  nonce from that same file, which core accepts as proof the line belongs to the holder. Use
  `withCaptureHeld`, which also guarantees the attempt to return to `idle`.
- **Both sides of the hold compare before they write, and a turn is identified by pid AND nonce.**
  The hold goes up before the booking race is resolved, so a publish declines when another turn's
  live hold exists and a clear writes `idle` only over our own record. Writing either
  unconditionally lets a losing ask free the winner's live hold, and core then speaks into an
  in-progress recording. The pid alone is not an identity: one host process can have two asks in
  flight. A publish that declines fails the ask (`microphone_busy`) rather than proceeding, since
  a turn with no hold has no interlock at all.
- **Every subprocess in a turn is bounded.** The capture state stays non-idle from the first
  recorded sample until the transcript exists, and core skips every voice line while it is, so an
  unbounded child mutes Echo for as long as the calling host lives. A turn has exactly two caps:
  the recorder gets `ECHO_CONVERSE_MAX_CAPTURE_MS`, and the whole transcription phase shares one
  `ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS` budget, so adding a step to that phase must draw from
  the same deadline rather than take a cap of its own. The turn's lease is derived from both, so
  the arithmetic breaks the moment a step gets its own cap.
- **A cancel must never strand the booking.** `POST /turn` is not cancellable: the caller has to
  learn `turn_id`, because a booking nobody can name is a booking nobody can release. A signal
  that fired before capture is honored by aborting the granted turn; during capture it reaches
  the recorder and the existing catch releases.
- **The capture owner writes its own pid** into the capture-state file. Core honors a non-idle
  state only while that pid is alive, so any other pid turns a crash into permanent silence.
- **Never import `core/`.** Core is reached over HTTP, plus the capture-state path core itself
  reports in `GET /health`. The daemon may run from another clone or a staged payload.
- **Do not change core's `/notify` contract or add a core endpoint** to make this easier. The
  deferred completion signal is named in `../docs/converse.md`; it is a core change with its own
  compatibility plan.
- Process state is user-owned (`~/.local/state/echo/converse`, `~/Library/Caches/echo/converse`),
  never `/tmp`. Recordings are deleted once transcribed, and the transcript is never sent to the
  coordinator.
- **An auto-started coordinator's output goes to `~/Library/Logs/echo-converse.log`.** Auto-start
  is the default deployment, so discarding its stdout leaves every `log()` call site unreadable.
  Never inherit the host's stdio instead: the MCP adapter carries JSON-RPC on stdout.
- `server.ts` exports a factory, not a started server. Importing it must never bind a port.

## Work Guidance

- Read the root `AGENTS.md` invariants and `../docs/converse.md` before editing.
- Add a config knob only when a caller or the coordinator actually reads it, and keep
  `shared/echo-env.ts` plus `shared/config-schema.json` in lockstep (a test enforces it).
- Pin host and tool behavior against installed sources rather than memory: the Pi tool
  `execute` argument order and the MCP wire shapes were both wrong in the obvious first source.

## Verification

```bash
bun test tests/converse/                                     # unit + invariants
ECHO_E2E_PORT=8921 ECHO_E2E_CONVERSE_PORT=8922 tests/e2e-converse.sh
```

Never point a test at the running daemon on `:3246` or a real coordinator on `:32468`. Start
isolated instances and prove the target first.

## Child DOX Index

There are no child `AGENTS.md` files under `converse/`.

## Maintaining this file

Keep this file for knowledge useful to almost every future session in this package. Do not
repeat what the code already shows; point to the authoritative file, command, or doc instead.
Prefer rewriting or pruning existing entries over appending new ones.

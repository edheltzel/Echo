# AGENTS.md

## Purpose

`converse/` is the `@echo/converse` workspace package: the one-shot voice ask. It owns the three
  concerns Echo's TTS daemon has never had - microphone capture, a local speech-to-text
  dependency, and a blocking request/response turn. Its opt-in playback reservation protocol
  extends `core/` additively while preserving the normal `/notify` contract.

Full design, the TCC evidence behind the process topology, the endpoint contract and the known
v1 limits: **[../docs/converse.md](../docs/converse.md)**.

## Ownership

- **Coordinator side** (`server.ts`, `main.ts`, `booking.ts`, `playback.ts`, `config.ts`,
  `types.ts`): books the microphone, speaks the question through core, waits for its exact
  playback completion and capture reservation.
- **Caller side** (`client.ts`, `capture.ts`, `capture-state.ts`, `host-tool.ts`): opens the
  microphone, transcribes locally, publishes capture state, and exposes `echo_ask` to hosts.
- Host wiring lives in `adapters/*`, never here. This package knows nothing about Pi, omp or
  Claude Code beyond the `source` tag a caller passes.

## Local Contracts

- **The coordinator never opens the microphone and never spawns a subprocess.** macOS gives a
  background process no TCC responsible process, no prompt surface and no grant, so capture must
  happen in the calling host's own process tree. Direct imports and spawn sites are guarded by
  source-level checks in `../tests/converse/architecture-invariants.test.ts`; those checks do not
  enforce runtime process ancestry or indirect dependency behavior.
- **Speak while idle, capture after completion.** The capture state flips to `recording` only after
  the coordinator reports this request's playback completed and core has reserved the queue, or core's own guard silences the question converse
  asked it to speak. Use `withCaptureHeld`, which also guarantees the return to `idle`.
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
- **A turn holds the booking AND core's capture reservation, and no path may free one without
  the other.** Core skips every voice line while it holds a reservation, so a leak is the
  operator's Echo going silent. Every exit (complete, abort, and the expiry sweep whose caller is
  already gone) goes through the one cleanup helper, and a release core answered non-2xx is
  retried and then logged - never discarded as success.
- **The capture owner writes its own pid** into the capture-state file. Core honors a non-idle
  state only while that pid is alive, so any other pid turns a crash into permanent silence.
- **Never import `core/`.** Core is reached over HTTP, plus the capture-state path core itself
  reports in `GET /health`. The daemon may run from another clone or a staged payload.
- **Core's normal `/notify` contract remains receipt-based.** Converse may use the additive
  `capture_reservation` request field plus per-request completion and reservation-release routes;
  ordinary callers do not opt in and retain the existing response and queue behavior.
- Process state is user-owned (`~/.local/state/echo/converse`, `~/Library/Caches/echo/converse`),
  never `/tmp`. Recordings are deleted once transcribed, and the transcript is never sent to the
  coordinator.
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

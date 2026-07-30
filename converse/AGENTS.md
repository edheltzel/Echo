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
  background process no TCC responsible process, no prompt surface and no grant, so capture stays
  in the caller-side adapter. Direct Pi/omp ancestry matches the measured terminal topology;
  Claude Code's MCP ancestry is unverified. Source checks in
  `../tests/converse/architecture-invariants.test.ts` do not enforce runtime ancestry or indirect
  dependency behavior.
- **Speak while idle, capture after completion.** The capture state flips to `recording` only after
  the coordinator reports this request's playback completed and core grants the reservation, or
  core's own guard silences the question. Use `withCaptureHeld`, which returns to `idle` in its
  finally.
- **Every subprocess in a turn is bounded.** The capture state stays non-idle from the first
  recorded sample until the transcript exists, and core skips every voice line while it is, so an
  unbounded child mutes Echo for as long as the calling host lives. A turn has exactly two caps:
  the recorder gets `ECHO_CONVERSE_MAX_CAPTURE_MS`, and the whole transcription phase shares one
  `ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS` budget, so adding a step to that phase must draw from
  the same deadline rather than take a cap of its own. Short or unsupported leases are refused,
  never clamped, and both booking and core reservation expiry are rebased at the capture grant.
- **A cancel must never strand the booking.** `POST /turn` is not cancellable: the caller has to
  learn `turn_id`, because a booking nobody can name is a booking nobody can release. A signal
  that fired before capture is honored by aborting the granted turn; during capture it reaches
  the recorder. Checks after transcription and after completion bookkeeping make cancellation
  terminal even when a child has already produced a valid result.
- **The capture owner writes its own pid** into the capture-state file. Core honors a non-idle
  state only while that pid is alive, so any other pid turns a crash into permanent silence.
- **Never import `core/`.** Core is reached over HTTP, plus the capture-state path core itself
  reports in `GET /health`. The daemon may run from another clone or a staged payload.
- **Core's normal `/notify` contract remains receipt-based.** Converse adds exact completion plus
  capture-reservation grant/release routes. The coordinator-generated reservation id exists before
  `/notify`, and every pre-grant exit releases it, so a lost response cannot make accepted core
  state unnameable. Ordinary callers do not opt in and retain existing queue behavior.
- Process state is user-owned (`~/.local/state/echo/converse`, `~/Library/Caches/echo/converse`,
  `~/Library/Logs/echo-converse.log`), never `/tmp`. Every intermediate audio file is `0600` and
  deleted on every path; the transcript is never sent to the coordinator.
- `server.ts` exports a factory, not a started server. Importing it must never bind a port.

## Work Guidance

- Read the root `AGENTS.md` invariants and `../docs/converse.md` before editing.
- Add a config knob only when a caller or the coordinator actually reads it, and keep
  `shared/echo-env.ts` plus `shared/config-schema.json` in lockstep (a test enforces it).
- Pin host and tool behavior against installed sources rather than memory: the Pi tool
  `execute` argument order and the MCP wire shapes were both wrong in the obvious first source.

## Verification

```bash
bun test tests/converse/                                     # unit + invariants + process race
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

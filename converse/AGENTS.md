# AGENTS.md

## Purpose

`converse/` is the `@echo/converse` workspace package: the one-shot voice ask. It owns the three
concerns Echo's TTS daemon has never had - microphone capture, a local speech-to-text
dependency, and a blocking request/response turn - without changing `core/`.

Full design, the TCC evidence behind the process topology, the endpoint contract and the known
v1 limits: **[../docs/converse.md](../docs/converse.md)**.

## Ownership

- **Coordinator side** (`server.ts`, `main.ts`, `booking.ts`, `playback.ts`, `config.ts`,
  `types.ts`): books the microphone, speaks the question through core, waits for playback drain.
- **Caller side** (`client.ts`, `capture.ts`, `capture-state.ts`, `host-tool.ts`): opens the
  microphone, transcribes locally, publishes capture state, and exposes `echo_ask` to hosts.
- Host wiring lives in `adapters/*`, never here. This package knows nothing about Pi, omp or
  Claude Code beyond the `source` tag a caller passes.

## Local Contracts

- **The coordinator never opens the microphone and never spawns a subprocess.** macOS gives a
  background process no TCC responsible process, no prompt surface and no grant, so capture must
  happen in the calling host's own process tree. Enforced by
  `../tests/converse/architecture-invariants.test.ts`.
- **Speak while idle, capture after drain.** The capture state flips to `recording` only after
  the coordinator reports playback drained, or core's own guard silences the question converse
  asked it to speak. Use `withCaptureHeld`, which also guarantees the return to `idle`.
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

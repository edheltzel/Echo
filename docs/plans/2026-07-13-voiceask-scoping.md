# voice_ask for Echo — Scoping Synthesis (Themis)

**Date:** 2026-07-13 · **Status:** VALIDATED — all RedTeam verdicts in (see
`support/voiceask-scoping/redteam-stack-verdicts.md` and
`support/voiceask-scoping/redteam-pi-sdk-verdicts.md`); awaiting Ed's build decisions
**Sources:** three explorer reports in `support/voiceask-scoping/`
(`vl-anatomy.md` — VL codegraph-grounded · `ts-portability.md` — cross-vendor bridge ·
`echo-integration.md` — Echo codegraph-grounded) + RedTeam verdict files (same directory).

## Goal

A host-agnostic, two-way voice conversation capability (`voice_ask`: speak a question
aloud → capture the user's spoken reply → local STT → return text) for **any** coding
agent, with first-class support for Claude Code, Pi, and omp. All TypeScript/Bun
orchestration; no Python libraries/daemons to maintain (self-contained subprocess
binaries acceptable — Echo's existing edge-tts precedent). VoiceLayer is the reference
implementation to **mine, not port**.

## Converged architecture (all three lanes agree)

**A dedicated host-neutral `echo-converse` capability + thin per-host adapters.**

```
 Claude Code ──MCP tool──┐
 Pi / omp ──ext tool или─┤        ┌──────────────────┐    POST /notify     ┌────────────┐
        same MCP─────────┼──HTTP──│  echo-converse    │────(speak question)─▶│ core :8888 │
 scripts ──curl──────────┘  /ask  │  mic·STT·booking  │                     │ (untouched)│
                                  │  duplex turn      │◀──/health poll──────│            │
                                  └───────┬──────────┘                      └────────────┘
                                          │ writes recording-state.json
                                          ▼ (state=recording)
                            core/capture-guard.ts reads it → core HOLDS all TTS
                            (the #101 arbitration, reused in reverse — for free)
```

1. **`core/` changes not at all.** The question is spoken by POSTing `/notify` (full TTS
   chain reuse); playback completion observed via `/health play_queue`; the mic-vs-playback
   lock comes from `echo-converse` *writing* the capture-state file that
   `core/capture-guard.ts` already reads. Every invariant test stays green untouched.
2. **`echo-converse` owns the three new concerns** Echo has never had: mic capture, the
   STT dependency, and the blocking duplex turn — plus the single-mic **booking lock**
   (409-on-conflict; one mic, one human, N agents). VL's session-booking (`wx` atomic
   lock + PID-staleness) is the reference.
3. **Per-host thin adapters** (pure HTTP clients of `/ask`) — *paths RedTeam-VERIFIED
   against the installed SDKs*:
   - **Claude Code → MCP server** (`adapters/mcp/`). CONFIRMED: hooks can inject context
     at lifecycle events but cannot expose a model-invokable tool whose return lands as a
     tool_result mid-turn — MCP is the only path.
   - **Pi / omp → `pi.registerTool` in the EXISTING extension adapter.** CONFIRMED
     SUPPORTED on both runtimes (`@earendil-works` 0.78.1 `ExtensionAPI.registerTool`,
     types.d.ts:820, demonstrated in shipped examples; `@oh-my-pi` 16.4.8 types.d.ts:723 —
     identical `execute(toolCallId, params, signal, onUpdate, ctx)` arg order). **No MCP
     needed for Pi** — one added `registerTool` call in `adapters/pi/index.ts`. Caveat
     recorded: do NOT use omp's file-based CustomTool type (different arg order).
   - **Scripts → raw `POST /ask`.**
   All registered via the #77 reconcile-and-prune contract, wired into `scripts/install.sh`
   preflight + install_adapter + `--check`.

## The v1 voice pipeline (no Python, no NAPI)

Two tiers, selected at runtime:

| Stage | Tier 1 (macOS 26) | Tier 2 (portable) |
|---|---|---|
| Speak question | core `/notify` (existing TTS chain) | same |
| Capture + endpoint | **`yap dictate`** (Apple SpeechAnalyzer — one CC0 binary, zero model downloads) | **`sox`/`rec`** with `silence` effect (energy endpointing) or push-to-talk stop-file |
| STT | (included in yap) | **`whisper-cli --vad`** (whisper.cpp with **native ggml Silero VAD** — no onnxruntime) |
| Transcript polish | **none** — return raw; the calling agent interprets | same |

- VL's actual Python surface is smaller than assumed: sox + whisper-cli are already
  Python-free; only the *optional* polish LLM (`mlx_lm.server`) and cloned-voice TTS
  daemons are Python — both dropped for v1.
- **Conflict adjudicated by RedTeam (see `redteam-stack-verdicts.md`):** VL's VAD is
  `onnxruntime-node` in-process, zero Python, and it RUNS under Bun 1.3.14 + ORT 1.24.x
  in VL production ("crashes under Bun" applied to older combos only). The rebuild still
  avoids the addon (whisper's native VAD / sox / PTT) — by preference, not necessity.
- **Machine-verified (RedTeam, this host, 2026-07-13):** whisper-cpp 1.9.1 installed with
  `--vad`/`--vad-model` flags (VAD model file is a separate download); sox/rec installed
  with the `silence` effect; `yap` not installed but `brew info yap` resolves (stable
  1.2.0); host is macOS 26.5.2 → Tier 1 available.

## Hard-won VL lessons to carry (from vl-anatomy §8)

- Native-rate capture + resample in TS (sox streaming resample overruns — AirPods 24kHz).
- Decoupled pipe-reader / processor loop (inference latency must never starve the pipe).
- Cross-process recording-state with PID-liveness (already mirrored in Echo's guard).
- Atomic `wx` session lock + orphan reaping ("#1 reliability fix" per VL).
- STT resiliency ladder (resident server → CLI fallback), no-speech/trim gauntlet.
- Fail-closed voice policy + SSML strip; state files in `~/.local/state` 0700, never /tmp.
- Strictly sequential turn: TTS fully drains before mic opens (no barge-in in shipping VL;
  the "interrupt by talking" SDK is unwired — treat as future work, not parity).

## Design subtleties already identified

- **Self-hold trap:** converse must speak the question with state `idle`, wait for
  playback completion, *then* flip to `recording` — or core's guard silences its own question.
- **Completion observation is polling `/health`** (slightly racy vs other sessions'
  enqueues); airtight per-request completion signaling would touch the `/notify` contract —
  deferred, not v1.
- **TCC topology is the #1 spike:** mic permission attributes to the *responsible process*.
  An always-on daemon opening the mic = easy-to-miss prompt + standing grant on a background
  process. Favor: tiny booking layer + **on-demand capture child attributed to the host
  terminal**. Prototype FIRST; it constrains process topology.

## Open items gating a build plan

1. ~~RedTeam verdicts~~ — DONE, all claims validated (2026-07-13).
2. TCC spike (prototype, ~half a day) — FIRST build task.
3. Ed's decisions: naming/port for converse; local-only STT vs optional cloud rung;
   scope of v1 (one-shot ask vs conversational loop).

## Out of scope for v1

Real-time barge-in (unwired even in VL) · transcript polish LLM · cloned voices ·
waveform streaming to visualizers (see #106 for the state-file signal instead) ·
non-macOS platforms (Tier 2 is portable in principle; not a v1 target).

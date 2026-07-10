---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-brainstorm
execution: code
date: 2026-07-09
planned: 2026-07-09
status: implementation-ready
---

# Full-Speech Playback Fidelity + Voice Observability - Plan

> **Product Contract preservation:** Product Contract (Goal, Scope, Method, Requirements
> R1–R6) unchanged from the `ce-brainstorm` requirements. This plan adds the HOW (Key
> Technical Decisions, Implementation Units, Verification, Definition of Done) below the
> Product Contract.

## Goal Capsule

- **Objective:** When the voice system speaks, play the **entire** spoken line to completion —
  no ~12 s cutoff, no lost tail. Get durable logging into the environment first so this is
  debuggable long-term, then fix the truncation.
- **Product authority:** Ed.
- **Open blockers:** None. Phase 2's fix mechanism is deferred to execution by design (see
  KTD4), not blocked.

---

## What this is NOT

- **Not** speak-on-every-turn. Selective speaking stays exactly as-is.
- **Not** reading the agent's entire raw response aloud. The unit is the summary line already
  emitted.
- **Not** touching mute (`core/mute.ts`, `/mute`, `scripts/mute.sh`) — separate working feature.

## Scope (confirmed)

- **"The whole response" = the full summary line, played to completion.** The defect is a
  produced summary getting cut off mid-play. The fix target is *playback fidelity of the line
  we already generate* — no change to which turns speak or what text is chosen.

## Method — hard rails (TDD / verify-before-assume)

- **Never act on an assumption. Verify first, always.** No mechanism is "the cause" until an
  observed log row or a failing test demonstrates it.
- **Test-driven, phases sequential *because* of it.** Phase 1 builds the instrument (the
  audio-lifecycle record) that makes truncation measurable. Phase 2 writes a **failing test
  first** — assert `play_time ≈ clip_duration` (red), fix until green. Phase 1 is the
  prerequisite that makes Phase 2 testable, so the order is not negotiable.
- **Log location: `~/.agents/Echo/`.** All structured voice observability lands there (created
  `0700` if absent; `ECHO_*` env-overridable). `~/Library/Logs/echo.log` (launchd-managed) is
  left as-is.

## Proven facts (verified against logs + source)

- **The daemon speaks 100% of what it receives**, giving playback a 60 s ceiling
  (`playAudio`, `core/server.ts:537`; `AUDIO_PROCESS_TIMEOUT_MS`). It logs `✅ delivered` only
  after `afplay` returns.
- **The hook's client aborts its POST wait at 12 s** (`adapters/claudecode/hooks/handlers/VoiceNotification.ts:123`),
  while the daemon's synth-then-play returns in 13–29 s. 24 of 55 `voice-events.jsonl`
  `failed` entries are this false alarm — cross-referenced to `✅ delivered` at the same time.
- **No log records clip duration or actual play-time**, so a 20 s clip that plays only 12 s is
  currently indistinguishable from one that plays fully.

## Leading hypothesis (Phase 1 done): playback OVERLAP, not single-clip truncation

Phase 1 (merged, #89) + the `202` prototype + Ed's own report converge on one mechanism, and
it is **not** the daemon cutting a clip short:

- **The daemon has no playback serialization.** Each `/notify` spawns its own `afplay`, so two
  turns/sessions play **at the same time**. Measured: two back-to-back requests produced
  **~8 s of concurrent playback** (see Outstanding Questions → Prototype results). Ed
  corroborates directly — *"overlapping conversations, talking over each other."*
- R4 **falsified** the single-clip theories: a clip plays to completion even when the client
  aborts at 13 s. So "cut off / not the full speech" is almost certainly **a second voice
  starting over the first**, not truncation of one clip.
- **Still to confirm from production rows (don't over-assert):** whether *every* perceived
  truncation is overlap, or a minority has another cause. The tell is intersecting
  `play_started_at`/`play_ended_at` windows on the turns Ed flags. Overlap is the **primary
  Phase 2 target**; keep the lifecycle log watching for non-overlap outliers.

---

## Product Contract

Two phases, in order. Phase 2's mechanism is chosen from Phase 1's data.

### Phase 1 — Logging into the environment (observability)

- **R1 — Audio lifecycle record (daemon).** Per `/notify` that speaks, record: message char
  count, provider, synthesis duration, **the clip's real duration**, playback start + end
  wall-time, and playback exit reason (`completed` | `timed-out` | `killed` | `error`).
- **R2 — Honest outcome labels (hook).** The 12 s abort-after-POST gets its own label, not
  `failed`. Real network/HTTP failures stay `failed`.
- **R3 — Durable + readable, in `~/.agents/Echo/`.** Structured events under `~/.agents/Echo/`,
  keyed by `session_id` (+ daemon `request_id`) so hook and daemon rows correlate, surviving
  restarts.
- **R4 — First verification, before any code.** Time a direct `curl` of a long message to
  `/notify`, bypassing the hook. Full playback ⇒ hook-side; also cuts ⇒ daemon-side.

### Phase 2 — Full-speech fidelity + no overlap (the feature fix, TDD)

- **R7 — No overlapping playback (PRIMARY target).** Concurrent `/notify`s must not play at
  once: the daemon **serializes playback** (a play-queue) — or applies an explicit, deliberate
  concurrency policy — so a new turn never talks over an in-progress one. Failing test first:
  two overlapping requests must record **non-intersecting** `play_started_at`/`play_ended_at`
  windows (fails today — measured ~8 s overlap). Ships together with the `202` latency fix
  (Outstanding Questions): **`202` + queue, never bare fire-and-forget** (bare worsens overlap).
- **R5 — Single-clip completion (secondary).** A long line records `play_time ≈ clip_duration`,
  exit `completed` — guards against any residual single-clip truncation R4 didn't reproduce.
  Test-first; must fail before the fix if a real single-clip case exists, else recorded as
  already-satisfied with the R4 evidence.
- **R6 — No regression** to selectivity, the `202` latency win, or false-failure labels;
  existing tests stay green.

## Outstanding Questions (deferred until Phase 1 data exists)

- Does the truncation fix belong hook-side (abort/timeout), daemon-side (playback), or both?
  Decided from R1/R4 evidence.
- **`202`-on-receipt is a LATENCY fix, decoupled from truncation — do not conflate.** Returning
  `202` when the request is validated (then synth+play async) removes the blocking wait in the
  greeting hook (`VoiceGreeting.hook.ts` SessionStart, measured ~6.8 s median / 12 s max) and
  the Stop hook (~9–12 s/turn), and retires the 12 s client abort (no more false
  `failed`/`aborted`). It does **NOT** fix truncation: R4 proved the daemon already plays the
  full clip to completion. Two beneficiaries (latency + log honesty), not three.
- **Overlap risk of bare fire-and-forget.** The synchronous handler today gives *accidental*
  per-session serialization (the next turn can't start mid-play). Bare fire-and-forget removes
  it, so rapid turns could overlap — and overlap is a leading truncation suspect. So the real
  fork is `202` + a **serial play-queue** vs. bare fire-and-forget.

  **Prototype results (2026-07-10, throwaway `202` edit measured on `:8889`, then reverted):**
  - Latency fix works: `202` returned in **38 ms** (was ~7 s synchronous).
  - ALS survives fire-and-forget: the audio-lifecycle row still wrote correctly **after** the
    response returned (`clip 8.376 s`, `play 9310 ms`, `completed`) — observability preserved,
    Bun keeps the pending promise alive. `.catch()` on the un-awaited promise required.
  - **Overlap CONFIRMED:** two back-to-back requests produced **~8 s of concurrent playback**
    (B `19.533→31.612`, A `23.319→34.834`) — two `afplay` processes at once. The daemon has
    **no playback serialization**, so concurrent `/notify`s overlap in *both* the current and
    the `202` model (bare fire-and-forget just makes it easier to hit).
  - **Implication:** overlap is now the **leading truncation suspect** — concurrent
    sessions/turns talking over each other reads as "cut off." So ship `202` **with a serial
    play-queue** (or a queue independent of `202`), not bare. The production lifecycle log will
    confirm overlap by showing intersecting `play_started_at`/`play_ended_at` windows on the
    turns Ed perceives as truncated.

---

## Key Technical Decisions

- **KTD1 — Mirror the existing resolution-event logger, don't invent one.** `writeResolutionEvent`
  (`core/server.ts:1161`) already writes size-capped, env-pathed JSONL per `/notify`, tested by
  `tests/core/resolution-log.test.ts`. The audio-lifecycle writer copies that shape
  (env path, `_MAX_BYTES` rotation, best-effort swallowed errors).
- **KTD2 — New host-neutral module `core/audio-log.ts`** for the writer + a pure
  `classifyPlaybackOutcome` helper, mirroring the modular style of `core/circuit-breaker.ts` /
  `core/mute.ts`. Keeps the pure logic importable in unit tests **without booting the
  `core/server.ts` singleton** (the #47 flake surface — see AGENTS.md invariant).
- **KTD3 — Two correlated files in `~/.agents/Echo/`**, not one shared file: daemon writes
  `audio-lifecycle.jsonl`, hook writes `voice-events.jsonl`, joined on `session_id`. Avoids two
  processes interleaving/tearing appends to one file.
- **KTD4 — Phase 2 mechanism deferred to execution.** The fix target is the outcome
  (`play_time ≈ clip_duration`); the specific code change is chosen from Phase 1 evidence. This
  is a deliberate planning-time / execution-time split, not an unfinished plan.
- **KTD5 — `afinfo` for clip duration.** Present at `/usr/bin/afinfo`; run best-effort on the
  temp file before cleanup. A failure logs `clip_duration: null`, never breaks `/notify`.
- **KTD6 — Playback exit reason from the `waitForProcess` outcome** (`core/server.ts:512`):
  clean exit ⇒ `completed`; the 60 s timeout kill ⇒ `timed-out`; non-zero/other ⇒ `killed` /
  `error`. `play_time` = wall-clock around the `afplay` await.

---

## Implementation Units

### U1. Audio-lifecycle event writer + outcome classifier (daemon)

- **Goal:** A durable, size-capped JSONL writer for per-`/notify` audio-lifecycle events in
  `~/.agents/Echo/`, plus the pure `classifyPlaybackOutcome` helper. (R1, R3)
- **Requirements:** R1, R3.
- **Dependencies:** none.
- **Files:**
  - `core/audio-log.ts` (new) — `writeAudioLifecycleEvent`, `classifyPlaybackOutcome`,
    `AudioLifecycleEvent` type, `ECHO_AUDIO_LIFECYCLE_LOG` path resolver (default
    `~/.agents/Echo/audio-lifecycle.jsonl`), `ECHO_AUDIO_LIFECYCLE_LOG_MAX_BYTES` (default
    1 MB, floor 1 KB), `0700` dir creation.
  - `tests/core/audio-lifecycle-log.test.ts` (new).
- **Approach:** Copy `writeResolutionEvent`'s structure (append + size-cap rotation +
  swallowed errors). `classifyPlaybackOutcome(exitCode, timedOut)` → the exit-reason enum
  (KTD6). Env resolution follows the `ECHO_* ?? VOICESYSTEM_* ?? default` convention used
  across `core/`.
- **Patterns to follow:** `core/server.ts:1094-1190` (resolution-log constants + writer),
  `tests/core/resolution-log.test.ts`, `core/env.ts` `parseBoundedInt`.
- **Test scenarios:**
  - Writes one JSON line per call; appended lines are individually parseable.
  - Rotates/truncates when the file exceeds `_MAX_BYTES` (mirror resolution-log test).
  - Honors `ECHO_AUDIO_LIFECYCLE_LOG` override; creates the dir `0700` when absent.
  - A write error (unwritable path) is swallowed — the function never throws.
  - `classifyPlaybackOutcome`: exit 0 → `completed`; timed-out flag → `timed-out`; non-zero →
    `killed`; thrown/`error` → `error`.
- **Verification:** `bun test tests/core/audio-lifecycle-log.test.ts` green; a manual call
  drops a well-formed line into `~/.agents/Echo/audio-lifecycle.jsonl`.

### U2. Capture playback metrics in the daemon and emit the lifecycle event

- **Goal:** Measure clip duration, play start/end, and exit reason around `afplay`, thread them
  to the `/notify` handler, and write the U1 event beside the resolution event. (R1)
- **Requirements:** R1.
- **Dependencies:** U1.
- **Files:**
  - `core/server.ts` — instrument `playAudio` (`:537`) to return playback metrics
    (`play_started_at`, `play_ended_at`, `exit_reason`, `clip_duration_s` via `afinfo`); bubble
    them through `speakWithFallback` (`:1214`) result; call `writeAudioLifecycleEvent` in the
    `/notify` handler next to `writeResolutionEvent` (`:1419`).
  - `tests/core/playback-metrics.test.ts` (new) — covers the pure metric derivation.
- **Approach:** `playAudio` records wall-time around the existing `waitForProcess` await and
  reads `afinfo <tempfile>` (best-effort, before `cleanupAudioTempDir`) for `clip_duration_s`.
  Exit reason via `classifyPlaybackOutcome` (U1). Metrics ride the `speakWithFallback` return
  shape (`{success, provider, voice, attempts, muted}`) up to the handler, which writes the
  event. `afinfo`/write failures degrade to `null`, never break playback.
- **Execution note:** afplay is a real side effect — keep the *derivation* (play_time from two
  timestamps, exit-reason classification, afinfo parse) in small pure functions unit-tested in
  `playback-metrics.test.ts`; cover the real end-to-end play in the smoke test (U-level
  Verification), not a unit test.
- **Patterns to follow:** `writeResolutionEvent` call site (`core/server.ts:1416-1430`);
  `playAudio` / `waitForProcess` (`:537`, `:512`).
- **Test scenarios:**
  - `afinfo` output parses to seconds; unparseable/missing output → `clip_duration_s: null`.
  - `play_time` computed from start/end timestamps; a known-short clip yields a plausible value.
  - Exit-reason wired correctly for clean completion vs. the 60 s timeout-kill path.
  - Muted `/notify` (`result.muted`) records no playback (or an event marked muted) — no crash.
  - Smoke: a real `/notify` on an ephemeral port writes an `audio-lifecycle.jsonl` row with all
    fields populated.
- **Verification:** `PORT=8889 tests/smoke-core.sh` plays a message and the row shows
  `play_time ≈ clip_duration`, exit `completed`; `bun test` green (no `server.stop()` in
  `afterAll` — AGENTS.md #47).

### U3. Route hook events to `~/.agents/Echo/` + honest abort label

- **Goal:** Move the hook's `voice-events.jsonl` to `~/.agents/Echo/` and stop the 12 s
  abort-after-POST from being logged as `failed`. (R2, R3)
- **Requirements:** R2, R3.
- **Dependencies:** none (parallelizable with U1/U2).
- **Files:**
  - `adapters/claudecode/hooks/handlers/VoiceNotification.ts` — repoint `VOICE_LOG_PATH`
    (`:52`) to `~/.agents/Echo/voice-events.jsonl` (create `0700`); in `sendNotification`
    (`:154-162`) tag the `AbortError` path with a distinct outcome (e.g. `event_type: 'aborted'`
    or `outcome: 'abort-after-send'`) separate from real `failed`.
  - `tests/adapters/claudecode/voice-event-logging.test.ts` (new).
- **Approach:** Extend the `VoiceEvent` union with the abort outcome; branch on
  `error.name === 'AbortError'` (already detected at `:156`) to log the new outcome. Keep the
  secondary work-dir `voice.jsonl` write (`:83-90`) untouched (out of scope). The 12 s timeout
  *value* is unchanged — labeling only.
- **Patterns to follow:** existing `logVoiceEvent` + `VoiceEvent` (`VoiceNotification.ts:40-91`).
- **Test scenarios:**
  - An `AbortError` after POST logs the abort outcome, **not** `failed`.
  - A genuine non-OK HTTP response still logs `failed` with status.
  - A 200 logs `sent`.
  - Events land under `~/.agents/Echo/` with the dir created when absent.
- **Verification:** `bun test tests/adapters/claudecode/voice-event-logging.test.ts` green;
  a live long-message turn writes an `aborted` (not `failed`) row.

### U4. Full-speech fidelity fix — test-first, mechanism deferred (Phase 2, CONTINGENT)

- **Goal:** The complete spoken line always plays; no tail lost. (R5, R6)
- **Requirements:** R5, R6.
- **Dependencies:** U1, U2, U3 landed **and** Phase 1 runtime data + R4 curl test collected.
  **Do not start U4 before Phase 1 data identifies the cutoff.**
- **Files:** the cutoff site Phase 1 fingers — **deferred** (likely `core/server.ts` playback
  path and/or `VoiceNotification.ts` abort/timeout); plus
  `tests/core/full-speech-fidelity.test.ts` (new, smoke-driven).
- **Approach:** Deferred to execution by KTD4. Fixed contract regardless of mechanism: write
  the failing `play_time ≈ clip_duration` / exit-`completed` assertion first (must reproduce the
  truncation Phase 1 observed), then apply the minimal change until green.
- **Execution note:** Test-first. The red assertion runs against the U1/U2 lifecycle record via
  smoke (a deliberately long line), not a pure unit test. Prove red before fixing.
- **Test scenarios (contract; concrete inputs set at execution):**
  - A ~25–30 s summary line records `play_time ≈ clip_duration` (within a small tolerance),
    exit `completed` — **fails before the fix, passes after**.
  - A short line still plays fully (no regression).
  - Selectivity unchanged: the same turns speak as before (existing hook tests green).
- **Verification:** the red test from R5 goes green; `bun test` + `PORT=8889 tests/smoke-core.sh`
  + the Pi build all pass (AGENTS.md pre-ship gate).

---

## Verification Contract

- **Gate 1 (R4, before code):** direct `curl` of a long message to `/notify` narrows hook-side
  vs. daemon-side. Record the result in the PR.
- **Gate 2 (Phase 1 done):** `bun test` green including the three new tests; a live turn writes
  correlated rows to `~/.agents/Echo/audio-lifecycle.jsonl` + `voice-events.jsonl`; a long turn
  shows either `play_time < clip_duration` (truncation caught) or `≈` (not reproduced — informs
  Phase 2).
- **Gate 3 (Phase 2 done):** the R5 red test is green; full line heard start-to-end repeatably;
  all prior tests + smoke + Pi build pass.
- **Ship gate (per AGENTS.md):** `bun test` + `PORT=8889 tests/smoke-core.sh` + the Pi
  `bun build` before any PR. Restart after `core/server.ts` edits:
  `launchctl kickstart -k "gui/$UID/com.echo"`.

## Risks & Mitigations

- **`afplay` can't be cleanly unit-tested** → pure derivation helpers unit-tested (U1/U2);
  real playback covered by smoke.
- **`afinfo` adds a subprocess per spoken `/notify`** → best-effort, errors → `null`; only on
  the play path; acceptable latency.
- **Two processes, one directory** → separate files per KTD3; no shared-file append race.
- **Test teardown flake (#47)** → never call `server.stop()` in `afterAll`; use the ephemeral
  `PORT=0`/`PORT=8889` pattern.
- **Truncation may not reproduce under `curl`** → then it is hook/Claude-Code-lifecycle-bound;
  R4 + Gate 2 surface that explicitly rather than hiding it.

## Definition of Done

- ✅ Phase 1 (U1–U3) merged (#89): audio-lifecycle + hook events write to `~/.agents/Echo/`,
  correlated by `session_id`; the 12 s abort no longer logs as `failed`; new tests green.
- ✅ R4 verification run: daemon plays clips to completion (not the cause); overlap confirmed.
- A day of real-use data collected; **overlap confirmed as the dominant cause** from
  intersecting play windows on flagged turns (or a non-overlap outlier surfaced).
- Phase 2 (U4) merged:
  - **R7:** two overlapping requests record non-intersecting play windows — no talking-over
    (the primary fix); shipped as `202` + serial play-queue.
  - **R5:** `play_time ≈ clip_duration` holds for a long line (no residual single-clip cut).
  - `bun test` + smoke + Pi build all pass; a rapid burst of turns is heard one-at-a-time, in
    full.

## Sources & Research

- Origin brainstorm: this file's Product Contract (`product_contract_source: ce-brainstorm`).
- Code grounding (this session): `core/server.ts` (`playAudio:537`, `waitForProcess:512`,
  `speakWithFallback:1214`, `writeResolutionEvent:1161`, resolution-log constants `:1094-1115`,
  handler `:1397-1434`); `adapters/claudecode/hooks/handlers/VoiceNotification.ts`
  (`logVoiceEvent:70`, `sendNotification:110`, 12 s abort `:123`); `~/Library/Logs/echo.log` +
  `voice-events.jsonl` cross-reference (24 false `failed`).
- Patterns to mirror: `tests/core/resolution-log.test.ts`, `core/circuit-breaker.ts`,
  `core/mute.ts`. Tooling: `/usr/bin/afinfo`.
- Invariants honored: AGENTS.md (`core/` host-neutral, no `server.stop()` in `afterAll`,
  user-owned paths not `/tmp`, `ECHO_*` env convention).

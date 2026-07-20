# Plan: CI Verification Gate + Echo↔VoiceLayer Capture Guard

## Context

The 2026-07-12 red-team of the four "worth stealing from VoiceLayer" recommendations (8-agent panel, Recall learnings #642) killed the priority-queue and replay-buffer ports outright, and left two surviving work items:

1. **A real verification gate.** VoiceLayer's "Verified-Runtime" CI gate is theater (it greps the PR body for a self-typed string). Echo should instead *machine-run* its existing verification trio — `bun test`, `tests/smoke-core.sh`, the Pi adapter build — which, unlike VoiceLayer's mic-TCC-bound stack, can boot headless in CI. Today the repo has **no CI at all** (no `.github/` directory).
2. **The side-by-side audio hazard.** When Echo and VoiceLayer run on the same Mac, Echo's `afplay` fires into an open VoiceLayer `voice_ask` mic capture — the mic hears Echo's TTS. VoiceLayer publishes a purpose-built cross-process signal for exactly this (`~/.local/state/voicelayer/recording-state.json`, doc comment: *"lets speaker output gates see VoiceBar captures"*), but Echo doesn't read it.

Ed's decisions (2026-07-12): plan **both** items; hold policy is **skip voice like mute** (banner still fires, disposition logged); Item B is **sequenced after the PR #92 decision**.

**State drift discovered during planning (verified):** PR #97 merged to dev today (`d81f724` — minimal 38-line `createSerialQueue`, 202-on-receipt, TTS cache), which re-broke PR #92 — now `OPEN / CONFLICTING / DIRTY`. #92's fuller PlayQueue (watchdog, age-cap, dispositions, banner-decoupling) overlaps #97's territory. So "after #92 merges" now means: **after Ed decides #92's fate** (rebase onto post-#97 dev, or close as superseded). #92 also carries accidental `$HOME/.claude/LIFEOS/...` file commits to drop in any rebase.

---

## Item A — GitHub Actions verification gate (PR 1, land now)

**One new file: `.github/workflows/verify.yml`.** No other code changes. All three trio steps are verified headless-safe on `ubuntu-latest` with only Bun installed:

- Smoke posts `voice_enabled:false` → the speech path (`speakWithFallback`) is never reached; no network, no afplay.
- The unconditional `osascript` banner spawn (`core/server.ts:1537-1545`) ENOENTs on Linux, async after the 202, swallowed by try/catch.
- `bun test` (31 files): every real-spawn path is mocked (spawn-seam stubs, `tests/core/mute.test.ts:30-47` pattern) or swallowed; tests use `PORT=0` + `mkdtemp` state paths. No root install step exists or is needed (metadata-only `package.json`, no lockfile).
- Pi build's only external (`@earendil-works/pi-coding-agent`) is peer-dep'd and excluded via `--external`.

```yaml
name: verify
on:
  pull_request:
    branches: [dev, master]
  push:
    branches: [dev, master]
concurrency:
  group: verify-${{ github.ref }}
  cancel-in-progress: true
jobs:
  verify:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - name: Unit tests
        run: bun test
      - name: Core smoke
        run: PORT=8889 tests/smoke-core.sh
      - name: Pi adapter build
        run: bun build adapters/pi/index.ts --target=bun --external @earendil-works/pi-coding-agent --outdir /tmp/echo-pi-build
      - name: Upload smoke log
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-core-log
          path: .smoke-core.log
          if-no-files-found: ignore
```

Rationale for the trigger set: PRs into `dev` gate feature work; PRs into `master` gate promotions on the merge ref; pushes verify post-merge reality. `bun-version: latest` matches current repo practice (no pin anywhere); pin only if a Bun release breaks CI. `.smoke-core.log` is the daemon's only diagnostic on a headless smoke failure (`tests/smoke-core.sh:5,11`).

**Docs in the same PR:** `CHANGELOG.md` (Added: CI verification gate); one line in `docs/development.md` noting CI runs the same trio.

**Manual follow-up (Ed, not automated):** after the first green run, add required status check `verify` to branch protection on `dev` and `master`.

---

## Gate between the items — Ed's #92 decision

Rebase #92 onto post-#97 dev (keep its unique value: dispositions, watchdog, age-cap, banner-decoupling; drop what #97 already shipped and the accidental `$HOME/.claude/...` files) **or** close it as superseded and cherry-pick dispositions later. This blocks Item B's start and determines its observability shape (boolean field vs `disposition` value). Item A's CI gate will cover whichever path is taken.

---

## Item B — capture guard (PR 2, after the #92 decision)

Skip-and-log, mirroring the mute gate verbatim. The guard check runs where the mute check already lives — `speakWithFallback` — so a line queued *during* a capture that dequeues *after* it ends plays normally; only lines whose turn arrives mid-capture drop their voice (banner unaffected). Zero interaction with any queue implementation.

### New module: `core/capture-guard.ts` (~70 lines, modeled on `core/mute.ts`)

- `resolveCaptureStatePath(): string | null` — env knob **`ECHO_CAPTURE_STATE_PATH`**; unset ⇒ default `join(homedir(), '.local', 'state', 'voicelayer', 'recording-state.json')` (VoiceLayer hardcodes `~/.local/state` with no XDG consult — match the writer); empty string `""` ⇒ guard disabled.
- `readCaptureState(path?, isPidAlive?): 'idle' | 'recording' | 'transcribing'` — tolerant read (missing/corrupt/wrong-shape ⇒ `'idle'`, never throws); validation mirrors VL's own reader (`recording-state.ts:34-53`); **non-idle requires pid liveness** (`process.kill(pid, 0)`) so a crashed VL session's stale file can't silence Echo forever; `isPidAlive` injectable for tests.
- `isCaptureActive(path?): boolean` — `state !== 'idle'`.

Default-in-core is invariant-clean: the path has no `/tmp` literal (architecture-invariants Invariant 3 scans `core/*.ts` for any non-comment `/tmp` substring) and VoiceLayer is a peer audio process, not a "host" in Echo's sense (hosts = Claude Code/Pi/OpenCode, which integrate via adapters). Missing file ⇒ idle, so the default is a no-op on machines without VoiceLayer.

### Surgical edits

1. **`core/server.ts` — `speakWithFallback`** (immediately after the mute gate, `:1296-1300` region on current dev): if `isCaptureActive()` → log and return `{ success: false, provider: 'capture-held', voice: null, attempts: [], held_for_capture: true }`. Extend the return-type union with `held_for_capture?: boolean` alongside `muted?`.
2. **`core/server.ts` — `sendNotification` event builders**: tag the resolution drop-off event (`:1509` region) and the lifecycle event (`:1520-1530` region) with `held_for_capture`, mirroring how `muted` flows today.
3. **`core/server.ts` — `/health`** (beside `mute: readMuteState()`, `:1777` region): add `capture_guard: { path: resolveCaptureStatePath(), state: readCaptureState() }`.
4. **`core/audio-log.ts`**: add `held_for_capture: boolean` to `AudioLifecycleEvent`. *(If #92 merged first: route through the `onDisposition` seam as `disposition: 'held-for-capture'` instead.)*
5. **`tests/smoke-core.sh`**: one line beside the existing mute pin — `export ECHO_CAPTURE_STATE_PATH="$(mktemp -d)/recording-state.json"` — so a real capture on the dev machine can never flake the smoke (or CI).

### Tests: `tests/core/capture-guard.test.ts` (mirror `tests/core/mute.test.ts` machinery)

Unit (mkdtemp paths, injectable `isPidAlive`): missing file ⇒ idle; corrupt JSON ⇒ idle; wrong shape ⇒ idle; `recording`+live pid ⇒ active; `recording`+dead pid ⇒ idle (stale-crash case); `transcribing`+live ⇒ active; env override honored at call time; `""` disables even when the default-path file says recording.

Gate (server-level: `PORT=0`, spawn stub via `mock.module("node:child_process")`, env pinned before dynamic import, `drainNotifications()` after POST, **no `server.stop()` in `afterAll`** per the #47 invariant):
- File says `recording` with live pid → POST `/notify` (voice on) → 202 → drain → zero provider spawns (banner osascript still recorded) → resolution event `held_for_capture: true`, lifecycle event `provider: 'capture-held'`.
- Flip to `idle` (or dead pid) → POST → provider spawn observed (speech resumes).
- `/health` includes `capture_guard` with pinned path and state.

### Docs (same PR)

`docs/configuration.md` (knob, default, `""`-disable, VL contract pointer) · `docs/http-api.md` (`capture_guard` in `/health`) · `CHANGELOG.md` · AGENTS.md repo-map row for `core/capture-guard.ts`.

### Out of scope (noted, not planned)

- Any VoiceLayer-side change; the reverse direction (Echo signaling *its* playback so VL delays opening the mic).
- Interrupting in-flight afplay when a capture starts mid-playback (ducking — different mechanism).
- Reading VL's `/tmp/voicelayer.sock` (state file is the published non-intrusive contract; a socket literal would trip Invariant 3 anyway).
- Bounded wait-then-play — only sane atop #92's watchdog/age-cap machinery; contained upgrade later if dropped lines prove annoying.

---

## Verification

Both PRs: the trio locally (`bun test` · `PORT=8889 tests/smoke-core.sh` · the Pi build command), which is exactly what CI runs.

Item A end-to-end: open the PR, confirm the `verify` check appears and goes green on the PR itself.

Item B end-to-end (live, on the Mac): `launchctl kickstart -k "gui/$UID/com.echo"` → start a VoiceLayer `voice_ask` → `curl -X POST localhost:8888/notify -H 'Content-Type: application/json' -d '{"message":"capture test"}'` → banner appears, **no audio**, `tail ~/.agents/Echo/audio-lifecycle.jsonl` shows `capture-held` → end the capture, repeat, audio plays → `curl localhost:8888/health | jq .capture_guard`.

## Sequencing summary

1. **PR 1 (now):** `.github/workflows/verify.yml` + docs. Independent of everything.
2. **Ed decides #92:** rebase onto post-#97 dev, or close as superseded.
3. **PR 2 (after 2):** capture guard as specified; observability shape follows the #92 outcome.

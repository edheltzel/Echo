# Themis Handoff — 2026-07-13

**From:** Themis (session ef7ee340) · **To:** next Themis instance
**Repo:** `/Users/ed/Developer/atlasEcho` · **Branch:** `dev` @ v0.5.0 released
**Reads first:** `AGENTS.md`, `ARCHITECTURE.md`, this file, then
`docs/plans/2026-07-13-voiceask-scoping.md` (the validated scoping) and its three
source reports + two RedTeam verdicts in `docs/plans/support/voiceask-scoping/`.

---

## Where things stand (shipped this cycle)

- **v0.5.0 released** (tag on master `39dcf3a` + GitHub release). Contents: capture guard
  (#101), play-queue hardening (#100, salvaged from the closed #92), CI verify gate (#99,
  now a **required** status check on dev+master), 202+serial queue+TTS cache (#97/#202),
  Ryan identity voice.
- **Promotion gotcha handled:** Ed's #104 dev→master promotion landed as a *rebase*, not a
  merge commit — dev dropped from master's ancestry. Applied the AGENTS.md remedy (merged
  master back into dev, empty reconciliation merge `393ff9d`). **Next promotion must be a
  merge commit** (the #74 lesson) — flag this to Ed at release time.
- Six merged branches deleted; board triaged (see below).

## Research complete & VALIDATED — host-agnostic `voice_ask`

Two-way voice (speak a question → capture + transcribe the spoken reply → return text) for
any coding agent. Fully scoped, every load-bearing claim adversarially verified on this
machine. **Converged architecture:**

- **`echo-converse`** — a host-neutral sibling capability (not on `core/`) owning the mic,
  STT, the blocking duplex turn, and a single-mic booking lock. Speaks questions by POSTing
  `core` `/notify` (whole TTS chain reused, `core/` untouched); **writes** the
  `recording-state.json` that `core/capture-guard.ts` already reads — so the #101 mic-vs-
  playback arbitration becomes the conversation's cross-process lock *for free, in reverse*.
- **Per-host consumption (RedTeam-verified against installed SDKs):**
  - **Claude Code → new MCP server** (`adapters/mcp/`). Hooks can inject context but cannot
    expose a model-invokable tool — MCP is the only path. CONFIRMED.
  - **Pi/omp → `pi.registerTool` in the EXISTING `adapters/pi/index.ts`.** SUPPORTED on both
    `@earendil-works` 0.78.1 and `@oh-my-pi` 16.4.8, identical `execute` arg order — **no MCP
    needed for Pi.** (Avoid omp's file-based `CustomTool` type — different arg order.)
  - **Scripts → raw `POST /ask`.**
- **v1 pipeline, zero Python / zero NAPI:** Tier 1 `yap dictate` (Apple SpeechAnalyzer;
  host is macOS 26.5.2 — one `brew install yap` away). Tier 2 portable: `sox`/`rec` (silence-
  effect endpointing or push-to-talk stop-file) + `whisper-cli --vad` (installed
  whisper-cpp 1.9.1 has the flags; VAD model is a separate download). Raw transcript, no
  polish LLM. All machine-verified.

## BLOCKED ON ED — three decisions before a build issue is cut

1. **v1 scope:** one-shot `voice_ask` (ask→answer→done) vs conversational loop (multi-turn
   in one mic session). One-shot is the honest v1.
2. **STT locality:** local-only (yap/whisper, no egress/keys) vs an optional cloud rung
   (would inherit Echo's egress-gating + circuit-breaker discipline).
3. **Name/port:** `echo-converse` on `:8890`? (8889 is the smoke-test port.)

## Next action items (priority order, for the next Themis)

1. **Get Ed's three decisions above.** Nothing downstream is safe to build without them.
2. **TCC mic-permission spike FIRST** (~half a day, a worker via `/ce-worktree`+`/ce-work`).
   Prototype who the mic-consent prompt attributes to: an always-on daemon opening the mic =
   easy-to-miss prompt + standing background grant; favor a tiny booking layer + **on-demand
   capture child attributed to the host terminal**. This constrains process topology — do it
   before any architecture code. Grounds:
   `docs/plans/support/voiceask-scoping/ts-portability.md` §2 (TCC) and
   `docs/plans/support/voiceask-scoping/echo-integration.md` §5.1.
3. **Cut the tracked build issue(s)** once (1)+(2) land — Ed must name it (issue creation is
   permission-gated; last two `gh issue create` calls required Ed's explicit go). Wire under
   epic **#30** (already cross-referenced) and note the #77 registration contract applies to
   the new `adapters/mcp/`.
4. **Design subtleties to bake into the build brief** (from the scoping doc): the *self-hold
   trap* (speak question at state `idle`, wait for playback, THEN flip to `recording`);
   completion observed by polling `core` `/health play_queue` (slightly racy — airtight
   signaling would touch the `/notify` contract, defer); booking = 409-on-conflict, not an
   invisible queue; all buffers user-owned, never `/tmp`.
5. **Carry VL's hard-won lessons** (vl-anatomy §8): native-rate capture + JS resample,
   decoupled reader/processor loop, atomic `wx` lock + orphan reaping, no-speech/trim
   gauntlet. Mine, don't port.

## Bridge & dispatch notes for the next session

- **Confirmed cross-vendor bridge this session: CodexResearcher (GPT-5.6 Sol)** via the
  Agent tool — re-confirm with Ed (bridge check-in is mandatory once per session).
- herdr explorers here were Claude Code panes (`Atlas`/Opus 4.8). Both closed cleanly.
- All research agents retired; no herdr tabs or subagents left running.

## Roadmap milestones (created 2026-07-13, Echo repo)

Single board is #20 "Atlas Echo" (only Echo board; consolidation already satisfied). All 20
open issues assigned to 4 phase milestones (ascending: harden → expand → distribute →
frontier):

- **Phase 1 — Correctness & Hardening** (7): #44 #45 #50 #51 #55 #98 #102
- **Phase 2 — Agent-Agnostic Adapters** (5): #16 #17 #29 #30 #63
- **Phase 3 — Distribution & Zero-Touch** (4): #8 #12 #13 #28
- **Phase 4 — Integrations & Two-Way Voice** (4): #94 #95 #96 #106 — **voice_ask lands
  here** once Ed's decisions unblock a build issue. Closed issues intentionally left
  unmilestoned (forward-planning only).

## GitHub board status (post-triage)

- **Filed this session:** #102 (import-purity — last unported #92 piece; `enhancement`,
  `agent-friendly`), #106 (publish Echo's playback state as a cross-process signal file;
  `enhancement`, `architecture`, `decoupling`). Both are clean agent-doable follow-ons.
- **Closed this session:** #91 (voice serialization — shipped in v0.5.0).
- **Relabeled:** #98 → `documentation` (still valid: edge-tts is cloud; stale local-only
  claims need an audit).
- **Epic #30** (agent-agnostic adapters) now carries the voice_ask cross-reference; its open
  sub-issues #16 (Codex) / #17 (OpenCode) will inherit the new adapter registration contract.
- **20 issues open total** — none are shipped-but-unclosed. Notable adjacent-to-voice ones:
  #94 (Ghostty OSC terminal notifications — the other "surface Echo's state" thread, sibling
  to #106), #28/#8/#12 (zero-touch install/NPM/onboarding — distribution, tracked separately
  from the epic).

## Constraints that bit / stay aware of

- Issue creation, branch deletion, and PR merges are **permission-gated** — Ed must name the
  action; Themis proposes, Ed authorizes. (Ed owns all merges — AGENTS.md.)
- `core/` is mechanically host-neutral (`no-host-strings` + `architecture-invariants`
  tests). `voice_ask` must NOT land on `core/`; `echo-converse` is a sibling.

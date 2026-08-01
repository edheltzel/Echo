# Vertical Release Plan — Echo v0.4.0 (publicizable cut)

**Author:** Themis · **Date:** 2026-07-03 · **Status:** AWAITING ED'S APPROVAL — no issues filed, no workers dispatched.

**Goal (Ed's directive):** a vertical feature set per harness — Pi and omp leveraging their hosts the way the vetted Claude Code adapter leverages its own — cut as a release we can publicize without a tail of fine-tune follow-ups. Process correctness per harness, not just code correctness.

**Evidence base (all four reports adversarially validated TRUSTWORTHY, corrections folded in below):**
- `.agents/atlas/artifacts/2026-07-03-claudecode-baseline.md` (+5 validator corrections)
- `.agents/atlas/artifacts/2026-07-03-pi-surface-gaps.md` (+3 corrections, gap #1 reframed)
- `.agents/atlas/artifacts/2026-07-03-omp-surface-gaps.md` (+lifecycle section corrections R1–R5)
- `.agents/atlas/artifacts/2026-07-03-process-audit.md` (12/12 confirmed, +4 validator-found misses)

---

## Product decisions — ED ONLY (block Wave 2 scoping)

| # | Decision | Context | Themis recommendation |
|---|---|---|---|
| P1 | **Zed (ACP) and RPC sessions already speak.** Keep, or gate behind config? | Validator refuted the scout: real UI contexts are wired in, `ctx.hasUI === true` — echo greets/speaks in Zed today. The real question is whether that's *wanted*, not how to build it. | Keep on; add `ECHO_VOICE_SURFACES` style opt-out only if you've heard it misfire in Zed |
| P2 | **omp built-in TTS coexistence** (`speech.enabled`, default off). If a user enables it, omp reads the full response INCLUDING our 🗣️ line, then echo speaks it again — double-speak confirmed real. | Kokoro/xAI stack, interactive TUI only. | Adapter detects `speech.enabled` in omp settings and suppresses echo's completion speech (greeting stays); document the interaction |
| P3 | **Pi/omp fallback summary**: CC speaks a fallback when no valid 🗣️ line; Pi stays silent by design. Parity or keep? | Baseline row 12. | Keep silent (Pi's model is instructed to emit the line; silence signals a prompt problem) — document as deliberate |
| P4 | **Approval-ping scope**: omp-only `tool_approval_requested` is confirmed and timely, BUT omp's default `approvalMode` is `"yolo"` — the event never fires for default-config users. | Pi side has no host event; adapter-approximable via `agent_end` + timer. | Ship omp approval ping now (it's cheap, fires for non-yolo users); defer the Pi idle-alert approximation |
| P5 | **License + version**: no LICENSE file exists (validator-found release blocker); `package.json` is `"private": true`, no license/repository fields. | Blocks any public cut. | MIT, `version 0.4.0`, drop `private`, add `license`+`repository` fields |

---

## Wave 1 — Release gates (parallelizable, no code risk, all docs/process)

From the process audit (12/12 confirmed) + validator finds. One worker can take all of it, or two split docs/scripts.

1. **LICENSE file + package.json fields** (P5) — *blocker, validator-found*
2. **D5**: purge private `atlas-config` references (README:188, docs/voices.md:19-20) + de-personalize leaning prose — *blocker*
3. ~~**D1/D2**: omp discoverability~~ ✅ closed by docs pass PR #85 (merged 5ecbe1c 2026-07-04)
4. **D3**: uninstall.sh leaves all three host registrations behind — add unregister (or document loudly) — *partially addressed: #85 documents survivors; unregister code still open*
5. ~~**D4**: upgrade procedure~~ ✅ closed by #85 (docs/operations.md)
6. **D6**: claudecode README names the actual Stop hook (VoiceCompletion.hook.ts) + `--check` — verify against #85 state
7. **D7**: catchphrase doc drift — ✅ README fixed by #85; the 16 stale `catchphrase` entries in voices.json remain (data cleanup)
8. **D8**: CHANGELOG duplicate `### Changed` under Unreleased
9. **D9–D12**: voice-status docs, development.md Pi-build step, ARCHITECTURE.md omp/reconcile mention, CONTRIBUTING adapter-contract step
10. **Validator finds**: PAI residue in claudecode adapter (PAI_SUPPRESS_VOICE, `~/.claude/MEMORY/*` writes on stock installs, hardcoded personal agent roster) — minimum: env-gate the PAI paths, neutralize the roster; tracked stale-brand diagram (`.agents/diagrams/atlas-voicesystem-codegraph.html`) — delete; README states macOS requirement

## Wave 2 — Vertical parity band (adapter code; sequenced)

Grounded in the corrected baseline map. B1 precedes B2 (extraction feeds persona switching).

- **B1 — Extraction hardening (Pi/omp)**: port CC's three false-positive guards to `voice-line.ts` — fence-awareness, column-0 rule, final-content-line rule. Validator proved all three absent; this band was undercounted as "parity in kind."
- **B2 — Per-turn persona voice (Pi/omp)** — *the flagship gap*: the 🗣️ `Name:` prefix is currently stripped and discarded; resolve it against voices.json keys (as CC's Stop hook does) and send the matching `voice_id` per turn. Daemon already host-neutral; adapter-only work.
- **B3 — Validation band parity**: CC's filler/conversational-starter filters and 10-char floor into the shared validator; catchphrase double-fire dedupe (CC-style) alongside Pi's existing 5s message-key dedupe.
- **B4 — Attention ping (per P4)**: omp `tool_approval_requested` → voice ping (with yolo caveat documented).
- **B5 — Double-speak guard (per P2)**.
- **B6 — CC-side hygiene (validator finds)**: VoiceGreeting is NOT registered async (worst case ~13s SessionStart hold on dead daemon) — fix registration or add fast-fail; `skipped` voice events typed but never logged — emit them; health-probe starvation under multi-agent load falsely routes to `say` (diagnosed 2026-07-03: per-notification python probe with 3s kill timer; fix = TTL-cache the verdict or treat timeout as proceed) — absorbs open issues #44/#50.
- **B7 — Runtime mute** ✅ SHIPPED (PR #84 → dev 7bc312b, #83 closed 2026-07-03, live closeout verified): global mute switch, timed or indefinite, endpoint + CLI + hotkey contract, log-only, persisted with expiry. Plan archived: `docs/plans/archive/2026-07-03-feat-runtime-mute-plan.md`.
- **Deliberately NOT adopted now (vertical ≠ everything)**: Pi `context` event, `message_update` early-TTS streaming, omp hooks subsystem, `ctx.memory`, remaining omp-only events. Recorded as post-release candidates.

## Wave 3 — Release cut

1. Full verification sweep: bun test + smoke + Pi build + live tri-harness checks (CC, Pi TUI, omp TUI + one Zed/ACP session per P1)
2. CHANGELOG groomed → `0.4.0`; promotion PR dev→master (**merge commit, never squash** — AGENTS.md rule)
3. Tag `v0.4.0` + GitHub release notes (headline: agent-agnostic voice — Claude Code, Pi, oh-my-pi; reconcile-and-prune installer; per-turn persona voice)
4. Post-release: file the deferred candidates as tracked issues under epic #30

## Dispatch shape (once Ed approves)

- Wave 1 → 1–2 Workers (docs/process), standard dual gate
- Wave 2 → B1+B2 one Worker (sequenced), B3–B6 second Worker; dual gate each; B2 additionally gets a live tri-harness RedTeam smoke
- Wave 3 → Themis-run verification + Ed merges promotion PR

**Estimated: 4 worker dispatches + gates. Waves 1 and 2 can run concurrently once P1–P5 are answered.**

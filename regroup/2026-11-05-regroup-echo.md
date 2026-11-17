# Regroup: Echo

Date: 2026-11-05
Source: `todo.txt` + `done.txt` (via `tuxedo lsa --json`), `docs/handoffs/`. Resume point: `docs/handoffs/2026-10-21-120730-handoff-echo-v0-13-0.md`.

## Last completed

- 2026-10-23: Published npm package `agent-echo@0.13.3`, v0.13.3 tagged, trusted publisher set (issue #8, PR #259).
- 2026-10-23: Pruned 35 merged remote branches; 10 unmerged left.

## Up next

- (B) Merge PR #249 (mute/mode for Jcode and Empryo) - blocked, waiting on Ed; NM test verdict inconclusive.
- (B) ATL-633 daemon-owned notice - blocked, waiting on Ed to name the mechanism.
- (B) Auto detect meetings (#126) - blocked, waiting on Ed for a design.
- (B) Auto-quiet during desktop voice conversations - paused on two research questions (owner: Atlas).

## Remaining

- (C) Tern terminal button for mute + sound modes - not started, due 2026-12-29.
- (C) Zero-touch UX docs (#28) - dep `echo-npm-8` now done, so unblocked; not started.
- (C) ATL-642 custom notification sounds - blocked, captain-hold until release.
- (C) Isolate HOME in pi/omp adapter tests - not started.
- 6 local test failures on BigMac - check against clean dev.
- Epic #30 agent-agnostic - in progress, closes with #17.
- OpenCode adapter #17 - in progress; headless greeting check needs a live session.
- ATL-632 Grok/xAI TTS - check BigMac for local work.
- Trial Pocket TTS via Kokoro endpoint on isolated daemon - not started.
- Promotion validation for dev-to-master (#230) - blocked, waiting on Ed.
- Decide /health X-Forwarded-For trust + localhost-only bind - not started.
- Decide silencing plain `claude -p` outside automation - not started.
- Docs site (#181), VoiceBar (#180), VoiceStudio (#195), first-class STT (#179) - backlogged.

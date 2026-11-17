# Regroup: Echo

Date: 2026-10-23
Sources: repo `todo.txt` and `done.txt` (via tuxedo), open and recently merged PRs for edheltzel/Echo, `origin/dev` and `origin/master`. Previous file: [2026-10-23-regroup-echo.md](2026-10-23-regroup-echo.md).
Resume point: [handoff](../docs/handoffs/2026-10-21-120730-handoff-echo-v0-13-0.md) (2026-10-21, newest).

## Last completed

- 2026-10-23: pruned 35 merged remote branches; 10 unmerged ones left.
- 2026-10-22: Echo mute and mode in every harness (Jcode skills, Empryo `$echo-mute` / `$echo-mode`), installed locally. Ships with #249.
- 2026-10-22: restarted `com.echo` on the 0.13.0 payload; healthy on :3246.
- 2026-10-21: v0.13.0 released (tag on master `f800126`, GitHub release), dev resynced with merge commit `7469780`.

## Up next

- `(A)` Publish the npm package (#8): name decided (`atlas-echo`). Commit `75dd31f` on local `feat/npm-atlas-echo` (no PR yet). Blocked on Ed to merge and tag, then the one-time manual npm publish and the npmjs.com trusted publisher.
- `(B)` Merge #249 (mute and mode for Jcode and Empryo): still open, MERGEABLE, blocked on Ed. Empryo checked by hand; Jcode `/echo-mute` recognized but not run (no Jcode model login).
- `(B)` ATL-633 daemon-owned notice: blocked on Ed naming the mechanism.
- `(B)` Auto-detect meetings (#126): blocked on Ed for a design.
- `(B)` Auto-quiet during desktop voice conversations: paused on two research questions.

## Remaining

- `(C)` Isolate `HOME` in the pi and omp adapter tests: not started.
- `(C)` Tern terminal mute/mode button: not started, SDK research only, due 2026-12-29.
- `(C)` Zero-touch UX docs (#28): blocked on #8.
- `(C)` ATL-642 custom notification sounds: blocked, held until Echo is released.
- Promotion validation for dev-to-master: blocked on Ed (waive No Mistakes or name another check).
- Decide `/health` X-Forwarded-For trust and localhost-only bind: blocked on Ed.
- Decide whether to silence plain `claude -p` outside automation: blocked on Ed.
- 6 local `bun test` failures on BigMac: not started (overlaps the `HOME` isolation task).
- OpenCode adapter (#17) and the agent-agnostic epic (#30): only the headless `opencode run` greeting check is left.
- ATL-632 xAI TTS: not started; check BigMac for local work.
- Pocket TTS trial through the Kokoro endpoint: not started.
- Roadmap ideas, backlogged: STT (#179), VoiceBar surface (#180), docs site (#181), VoiceStudio (#195).

## todo.txt

- `(A) 2026-10-09 Publish npm package atlas-echo for one-command install (npx atlas-echo install). Name decided by Ed 2026-10-23; package, bin, publish workflow and docs in the feat/npm-atlas-echo PR. Left: Ed merges and tags, then the one-time manual npm publish and the npmjs.com trusted publisher (edheltzel/Echo, publish.yml) @waiting on Ed +echo issue:8 id:echo-npm-8`
- `(B) 2026-10-23 Merge PR #249 into dev (mute/mode for Jcode and Empryo). Pipeline test verdict inconclusive: host commands not driven live. Empryo $echo-mute verified live by hand; Jcode /echo-mute recognized but not run (Jcode has no working model login) on Ed pr:https://github.com/edheltzel/Echo/pull/249 +echo @waiting`

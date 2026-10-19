# Regroup: Echo

Date: 2026-10-18
Sources: repo `todo.txt` and `done.txt` (via tuxedo), global `~/todo.txt` route, GitHub PRs for edheltzel/Echo, `but status`. Previous file: [2026-10-15-regroup-echo.md](2026-10-15-regroup-echo.md).
Resume point: [handoff](../docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md) (2026-10-14, newest).

## Last completed

- 2026-10-17: #234 task lists and regroup records reconciled (merged).
- 2026-10-17: #233 CLI help output and rate-limit diagnostics fixed (merged). Covers todo lines 18 and 19, which are still open in `todo.txt`.
- 2026-10-17: #232 startup warnings silenced for retired config keys (merged).
- 2026-10-15: #230 dev to master promotion and #231 master ancestry repair (merged).

## Up next

- #236 silence notifications in automation sessions: open, CI green, waiting on review.
- #235 isolate /health from the notify rate limit: open, CI green, waiting on review.
- #17 OpenCode adapter (`@inprogress`): only the headless `opencode run` greeting check is left; needs a live session. Closes the #30 epic.

## Remaining

- Promotion validation for #230: blocked on Ed (waive No Mistakes for promotions or name another check).
- 6 local `bun test` failures: not started; compare against clean dev.
- ATL-632 xAI TTS: not started; check BigMac for local work.
- Pocket TTS trial through the Kokoro endpoint: not started.
- No Mistakes line in AGENTS.md: still open in `todo.txt`, but AGENTS.md "Development workflow" already has it.
- OpenCode HIL announce (`permission.asked`): not started, no issue.
- Auto-quiet during desktop voice conversations: paused on two research questions.
- Tern terminal mute/mode button: not started, SDK research only.
- #8 npm package: blocked on Ed (name, Bun bootstrap, publish flow). #28 zero-touch docs: blocked on #8.
- ATL-633 daemon-owned notice: blocked on Ed naming the mechanism.
- #126 meeting detection: blocked on a design from Ed.
- Remote branch pruning: blocked on Ed confirming.
- #179 STT, #180 VoiceBar, #181 docs site, #195 VoiceStudio: backlogged.

## Raw todo.txt lines

```
2026-10-09 6 local test failures on BigMac (bun test 2026-10-14): Claude plugin validate, runEchoMute, omp HIL announce, 2x Pi lifecycle, 1 integration override. Compare against clean dev; no issue +echo @check
2026-10-09 [Epic] Make the voice system agent-agnostic. OpenCode is the last host; closes when #17 closes +echo @inprogress issue:30
2026-10-09 Add OpenCode host adapter. Shipped (#198/#204); greeting on by default (#219). Left: headless opencode run greeting check (needs a live session) +echo @inprogress issue:17
2026-10-09 ATL-632 Grok as a speech provider (xAI TTS). On Oct 4 the xAI key "Echo" went into Echo's env file on BigMac, but there's no xAI/Grok TTS code on any GitHub branch and no issue. Check BigMac for local or uncommitted work +echo @check atl:632
2026-10-09 ATL-633 Daemon-owned notice (no name yet). @waiting on Ed to name the mechanism (not AppleScript, terminal, or Herdr); then spec + issue +echo atl:633
2026-10-09 Auto detect meetings. on Ed: needs a design (what is a meeting, who detects it, mute vs hold) +echo @waiting issue:126
2026-10-09 Auto-quiet during desktop voice conversations. The Oct 7 plan is paused on two research questions (who holds the mic; how desktop-app events reach Echo). Owner: Atlas +echo @outstanding
2026-10-09 OpenCode HIL announce (permission.asked). Regroup follow-up, no issue filed. Owner: Atlas +echo @outstanding
2026-10-09 Prune merged/duplicate remote branches (...). @waiting on Ed to confirm +echo
2026-10-09 Publish NPM package for one-command install. @waiting on Ed: package name, Bun required or bootstrapped, publish flow +echo issue:8 id:echo-npm-8
2026-10-09 Roadmap/explore: published documentation site. Backlogged idea +echo @outstanding issue:181
2026-10-09 Roadmap/explore: VoiceBar-class macOS surface. Backlogged idea +echo @outstanding issue:180
2026-10-09 Roadmap/explore: VoiceStudio as a local edge-tts replacement. Backlogged idea, needs-triage +echo @outstanding issue:195
2026-10-09 Roadmap: first-class speech-to-text (STT). Backlogged idea +echo @outstanding issue:179
2026-10-09 Tern terminal button to toggle Echo mute + sound modes (Tern SDK). ... +echo @outstanding
2026-10-09 Zero-touch UX docs for non-developers. Waits on #8 (delivery half moved there) +echo issue:28 dep:echo-npm-8
2026-10-15 Add a no-mistakes axi --yes workflow line to AGENTS.md +echo note:docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md
2026-10-15 Fix cli/echo --help backticks being evaluated by the shell +echo note:docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md
2026-10-15 Fix cli/echo doctor reporting a /health 429 as a foreign port owner +echo note:docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md
2026-10-15 Trial Pocket TTS through the Kokoro endpoint on an isolated daemon +echo note:docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md
2026-10-17 Decide promotion validation: #230's No Mistakes run was cancelled (pipeline rebases, breaking the merge commit). Ed to waive NM for dev-to-master promotions or name another promotion check +echo @waiting pr:https://github.com/edheltzel/Echo/pull/230
```

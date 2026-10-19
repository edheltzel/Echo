# To-do

Generated view of [todo.txt](todo.txt) (open tasks) and [done.txt](done.txt) (archive), managed with `tuxedo`. Synced 2026-10-19.

## Open

- [ ] 2026-10-09 **Waiting:** Publish NPM package for one-command install. on Ed: package name, Bun required or bootstrapped, publish flow issue:8
- [ ] 2026-10-09 **Waiting:** ATL-633 Daemon-owned notice (no name yet). on Ed to name the mechanism (not AppleScript, terminal, or Herdr); then spec + issue atl:633
- [ ] 2026-10-09 **Waiting:** Auto detect meetings. on Ed: needs a design (what is a meeting, who detects it, mute vs hold) issue:126
- [ ] 2026-10-09 Auto-quiet during desktop voice conversations. The Oct 7 plan is paused on two research questions (who holds the mic; how desktop-app events reach Echo). Owner: Atlas @outstanding
- [ ] 2026-10-09 Tern terminal button to toggle Echo mute + sound modes (Tern SDK). from Echo room, Oct 9. New feature request. Tern SDK research in progress, no brief yet. Mute toggles with one POST /mute; /mode has no toggle form yet @outstanding due:2026-12-29
- [ ] 2026-10-09 Zero-touch UX docs for non-developers. Waits on #8 (delivery half moved there) issue:28
- [ ] 2026-10-19 **Waiting:** ATL-642 Custom notification sounds. Config for custom audio files; play when a notification fires. Captain-hold until Echo is released. atl:642
- [ ] 2026-10-09 6 local test failures on BigMac (bun test 2026-10-14): Claude plugin validate, runEchoMute, omp HIL announce, 2x Pi lifecycle, 1 integration override. Compare against clean dev; no issue @check
- [ ] 2026-10-09 [Epic] Make the voice system agent-agnostic. OpenCode is the last host; closes when #17 closes @inprogress issue:30
- [ ] 2026-10-09 Add OpenCode host adapter. Shipped (#198/#204); greeting on by default (#219). Left: headless opencode run greeting check (needs a live session) @inprogress issue:17
- [ ] 2026-10-09 ATL-632 Grok as a speech provider (xAI TTS). On Oct 4 the xAI key "Echo" went into Echo's env file on BigMac, but there's no xAI/Grok TTS code on any GitHub branch and no issue. Check BigMac for local or uncommitted work @check atl:632
- [ ] 2026-10-09 **Waiting:** Prune merged/duplicate remote branches (feat/notification-sounds, feat/install-onboarding-12, fix/test-preload-overrides, fix/test-xdg-leak, docs/low-risk-merge-rule, feat/preview-voices-help-13, fix/registrar-dedupe-63, chore/resync-dev-with-master, chore/restore-master-ancestry, feat/opencode-adapter, fix/opencode-prune-config-plugin(-dev), docs/regroup-2026-10-07, cursor/fm-352, fm-365). on Ed to confirm
- [ ] 2026-10-09 Roadmap/explore: published documentation site. Backlogged idea @outstanding issue:181
- [ ] 2026-10-09 Roadmap/explore: VoiceBar-class macOS surface. Backlogged idea @outstanding issue:180
- [ ] 2026-10-09 Roadmap/explore: VoiceStudio as a local edge-tts replacement. Backlogged idea, needs-triage @outstanding issue:195
- [ ] 2026-10-09 Roadmap: first-class speech-to-text (STT). Backlogged idea @outstanding issue:179
- [ ] 2026-10-15 Trial Pocket TTS through the Kokoro endpoint on an isolated daemon - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md)
- [ ] 2026-10-17 **Waiting:** Decide promotion validation: #230's No Mistakes run was cancelled (pipeline rebases, breaking the merge commit). Ed to waive NM for dev-to-master promotions or name another promotion check - [pr](https://github.com/edheltzel/Echo/pull/230)
- [ ] 2026-10-19 Decide whether the /health limiter should stop trusting X-Forwarded-For and whether the daemon should bind localhost only - [note](docs/handoffs/2026-10-19-122550-handoff-echo-automation-silence.md)
- [ ] 2026-10-19 Decide whether to silence plain claude -p sessions outside automation - [note](docs/handoffs/2026-10-19-122550-handoff-echo-automation-silence.md)
- [ ] 2026-10-19 Research Echo support for Empryo sessions (https://empryo.com/docs/). Empryo loads Claude Code hooks from ~/.claude/settings.json unchanged (docs/tools/hooks: Stop, SessionStart, Notification permission_prompt), but this Empryo session produced no Echo delivery in echo.log or voice-events.jsonl. Find why (hook loading per surface, transcript_path format vs the Claude parser, hook env subset), then decide reuse of adapters/claudecode vs a new adapters/empryo. Automation silence needs EMPRYO_HOOK_ENV=NO_MISTAKES_GATE because hooks get a safe env subset @outstanding

## Done

- [x] 2026-10-19 Add a no-mistakes axi --yes workflow line to AGENTS.md - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md), [pr](https://github.com/edheltzel/Echo/pull/233)
- [x] 2026-10-19 Fix cli/echo --help backticks being evaluated by the shell - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md), [pr](https://github.com/edheltzel/Echo/pull/233)
- [x] 2026-10-19 Fix cli/echo doctor reporting a /health 429 as a foreign port owner - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md), [pr](https://github.com/edheltzel/Echo/pull/233)
- [x] 2026-10-19 Merge #235 and #236, then cli/echo update and bun run restart - [note](docs/handoffs/2026-10-19-122550-handoff-echo-automation-silence.md), [pr](https://github.com/edheltzel/Echo/pull/235), [pr](https://github.com/edheltzel/Echo/pull/236)
- [x] 2026-10-19 Verify an automation run stays silent on the live daemon. NO_MISTAKES_GATE=1 claude -p ran with no new echo.log delivery; omp -p is already silent in print mode - [note](docs/handoffs/2026-10-19-122550-handoff-echo-automation-silence.md)

## Archived (done.txt)

- [x] 2026-10-15 Detect Herdr: stay as today if missing, talk to Herdr if present. Shipped in #133; documented in #215; #191 closed issue:191 - [pr](https://github.com/edheltzel/Echo/pull/215)
- [x] 2026-10-15 fix: keep test daemons' banners off the operator's screen. Merged as #213 - [pr](https://github.com/edheltzel/Echo/pull/213)
- [x] 2026-10-15 FM-352 / FM-356 Pi extension finish + RedTeam review. Merged as #174 - [pr](https://github.com/edheltzel/Echo/pull/174)
- [x] 2026-10-15 FM-353 Thin Claude Code plugin. Merged as #176 - [pr](https://github.com/edheltzel/Echo/pull/176)
- [x] 2026-10-15 FM-365 Echo extension API / surface. Merged as #177 - [pr](https://github.com/edheltzel/Echo/pull/177)
- [x] 2026-10-15 herdr socket api for agent types. Closed not planned; see docs/adapters.md for the upstream limitation issue:96 - [pr](https://github.com/edheltzel/Echo/pull/217)
- [x] 2026-10-15 Installed daemon branch on BigMac. Verified 2026-10-15: BigMac runs payload 0.12.0 with /mode
- [x] 2026-10-15 Jev seats: interrupt/duck, mute gate, wake vs ignore. Spike delivered in #220; #194 closed; see docs/plans/2026-10-09-jev-decision-seats-spike.md for the verdicts issue:194 - [pr](https://github.com/edheltzel/Echo/pull/220)
- [x] 2026-10-15 OpenCode adapter: runtime persona & voice. Shipped in #204; #129 closed issue:129 - [pr](https://github.com/edheltzel/Echo/pull/204)
- [x] 2026-10-15 Promote dev → master. Merged as #223 - [pr](https://github.com/edheltzel/Echo/pull/223)
- [x] 2026-10-15 Publish playback state as a cross-process signal file. Shipped in #218; #106 closed issue:106 - [pr](https://github.com/edheltzel/Echo/pull/218)
- [x] 2026-10-15 Regroup doc branch docs/regroup-2026-10-07. Regroup record landed in #227; branch pruning remains in todo.txt - [report](regroup/2026-10-07-regroup-echo.md), [pr](https://github.com/edheltzel/Echo/pull/227)
- [x] 2026-10-15 Route Echo notifications through Herdr with pane-aware context and focus. Herdr-first route shipped in #133; click-to-focus closed not planned; see docs/http-api.md for the limitation issue:95 - [pr](https://github.com/edheltzel/Echo/pull/216)
- [x] 2026-10-15 Promote dev to master for #226-#228. Squash-merged (not a merge commit); master ancestry restored by #231; No Mistakes run was cancelled after a failed test step, not passed - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md), [pr](https://github.com/edheltzel/Echo/pull/230), [pr](https://github.com/edheltzel/Echo/pull/231)

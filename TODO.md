# To-do

Mirror of `todo.txt` (source of truth, managed with `tuxedo`). Synced 2026-10-17.

## Open

- [ ] 2026-10-09 **Waiting:** ATL-633 Daemon-owned notice (no name yet). on Ed to name the mechanism (not AppleScript, terminal, or Herdr); then spec + issue atl:633
- [ ] 2026-10-09 Tern terminal button to toggle Echo mute + sound modes (Tern SDK). from Echo room, Oct 9. New feature request. Tern SDK research in progress, no brief yet. Mute toggles with one POST /mute; /mode has no toggle form yet @outstanding
- [ ] 2026-10-09 OpenCode HIL announce (permission.asked). Regroup follow-up, no issue filed. Owner: Atlas @outstanding
- [ ] 2026-10-09 Auto-quiet during desktop voice conversations. The Oct 7 plan is paused on two research questions (who holds the mic; how desktop-app events reach Echo). Owner: Atlas @outstanding
- [ ] 2026-10-09 **Waiting:** Auto detect meetings. on Ed: needs a design (what is a meeting, who detects it, mute vs hold) issue:126
- [ ] 2026-10-09 Zero-touch UX docs for non-developers. Waits on #8 (delivery half moved there) issue:28
- [ ] 2026-10-09 **Waiting:** Publish NPM package for one-command install. on Ed: package name, Bun required or bootstrapped, publish flow issue:8
- [ ] 2026-10-09 Roadmap: first-class speech-to-text (STT). Backlogged idea @outstanding issue:179
- [ ] 2026-10-09 Roadmap/explore: VoiceBar-class macOS surface. Backlogged idea @outstanding issue:180
- [ ] 2026-10-09 Roadmap/explore: published documentation site. Backlogged idea @outstanding issue:181
- [ ] 2026-10-09 Roadmap/explore: VoiceStudio as a local edge-tts replacement. Backlogged idea, needs-triage @outstanding issue:195
- [ ] 2026-10-09 ATL-632 Grok as a speech provider (xAI TTS). On Oct 4 the xAI key "Echo" went into Echo's env file on BigMac, but there's no xAI/Grok TTS code on any GitHub branch and no issue. Check BigMac for local or uncommitted work @check atl:632
- [ ] 2026-10-09 6 local test failures on BigMac (bun test 2026-10-14): Claude plugin validate, runEchoMute, omp HIL announce, 2x Pi lifecycle, 1 integration override. Compare against clean dev; no issue @check
- [ ] 2026-10-09 Add OpenCode host adapter. Shipped (#198/#204); greeting on by default (#219). Left: headless opencode run greeting check (needs a live session) @inprogress issue:17
- [ ] 2026-10-09 [Epic] Make the voice system agent-agnostic. OpenCode is the last host; closes when #17 closes @inprogress issue:30
- [ ] 2026-10-09 **Waiting:** Prune merged/duplicate remote branches (feat/notification-sounds, feat/install-onboarding-12, fix/test-preload-overrides, fix/test-xdg-leak, docs/low-risk-merge-rule, feat/preview-voices-help-13, fix/registrar-dedupe-63, chore/resync-dev-with-master, chore/restore-master-ancestry, feat/opencode-adapter, fix/opencode-prune-config-plugin(-dev), docs/regroup-2026-10-07, cursor/fm-352, fm-365). on Ed to confirm
- [ ] 2026-10-15 Add a no-mistakes axi --yes workflow line to AGENTS.md - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md)
- [ ] 2026-10-15 Fix cli/echo doctor reporting a /health 429 as a foreign port owner - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md)
- [ ] 2026-10-15 Fix cli/echo --help backticks being evaluated by the shell - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md)
- [ ] 2026-10-15 Trial Pocket TTS through the Kokoro endpoint on an isolated daemon - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md)

## Done

_None._

## Archived (done.txt)

- [x] 2026-10-15 Promote dev → master. master is still abdac2d (Sep 28) and all Oct 7–8 work is dev-only. Owner: Ed. ⚠ a promotion may be staged locally in GitButler @outstanding - [pr](https://github.com/edheltzel/Echo/pull/223)
- [x] 2026-10-15 OpenCode adapter: runtime persona & voice. Needs Ed's decision: close by hand or switch to env-wins precedence @outstanding issue:129 - [pr](https://github.com/edheltzel/Echo/pull/204)
- [x] 2026-10-15 Detect Herdr: stay as today if missing, talk to Herdr if present. Not started @outstanding issue:191 - [pr](https://github.com/edheltzel/Echo/pull/215)
- [x] 2026-10-15 Route Echo notifications through Herdr with pane-aware context and focus. Not started; separate from ATL-633. Herdr-first route shipped in #133; click-to-focus closed not planned (Herdr has no notification target) @outstanding issue:95 - [pr](https://github.com/edheltzel/Echo/pull/216)
- [x] 2026-10-15 herdr socket api for agent types. Not started; assigned Atlas-Key. closed not planned (Herdr has no parent/spawn lineage field) @outstanding issue:96 - [pr](https://github.com/edheltzel/Echo/pull/217)
- [x] 2026-10-15 Jev seats: interrupt/duck, mute gate, wake vs ignore. Not started @outstanding issue:194 - [pr](https://github.com/edheltzel/Echo/pull/220)
- [x] 2026-10-15 Publish playback state as a cross-process signal file. Branch cursor/fm-456-playback-state-6c32 (tip 1733444, Sep 10) is unmerged and the factory says awaiting-redteam, but the Oct 7 regroup says not started @check issue:106 - [pr](https://github.com/edheltzel/Echo/pull/218)
- [x] 2026-10-15 Regroup doc branch docs/regroup-2026-10-07. Never merged to dev; check whether it was meant to land @check - [report](regroup/2026-10-07-regroup-echo.md)
- [x] 2026-10-15 Installed daemon branch on BigMac. Sounds-only mode and /mode exist only on dev; confirm what BigMac runs before building the Tern button @check verified 2026-10-15: BigMac runs payload 0.12.0 with /mode
- [x] 2026-10-15 fix: keep test daemons' banners off the operator's screen. Open, mergeable (clean), adds ECHO_OSASCRIPT_BIN. Waiting on Ed's merge (or Atlas under the #212 low-risk rule) @inprogress pr:213 - [pr](https://github.com/edheltzel/Echo/pull/213)
- [x] 2026-10-15 FM-352 / FM-356 Pi extension finish + RedTeam review. Still "underway" in factory.db, but cursor/fm-352-pi-install-prove-72b2 is an ancestor of dev @close fm-352 branch is an ancestor of dev - [pr](https://github.com/edheltzel/Echo/pull/174)
- [x] 2026-10-15 FM-353 Thin Claude Code plugin. Still "underway" in factory.db; merged as PR #176 @close - [pr](https://github.com/edheltzel/Echo/pull/176)
- [x] 2026-10-15 FM-365 Echo extension API / surface. Still "underway" in factory.db; merged as #177 @close - [pr](https://github.com/edheltzel/Echo/pull/177)
- [x] 2026-10-15 Promote dev to master for #226-#228. Squash-merged (not a merge commit); master ancestry restored by #231; No Mistakes run was cancelled after a failed test step, not passed - [note](docs/handoffs/2026-10-14-205500-handoff-echo-scripts-release-voice.md), [pr](https://github.com/edheltzel/Echo/pull/230), [pr](https://github.com/edheltzel/Echo/pull/231)

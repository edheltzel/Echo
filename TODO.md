---

kanban-plugin: board

---

## Outstanding

- [ ] Generated Oct 9, 2026 from GitHub + crew notes; BigMac local docs not yet included
- [ ] Promote dev → master. master is still abdac2d (Sep 28) and all Oct 7–8 work is dev-only. Owner: Ed. ⚠ a promotion may be staged locally in GitButler
- [ ] [#129](https://github.com/edheltzel/Echo/issues/129) OpenCode adapter: runtime persona & voice. Needs Ed's decision: close by hand or switch to env-wins precedence
- [ ] ATL-633 Daemon-owned notice (no name yet). Blocked until Ed names the mechanism (not AppleScript, terminal, or Herdr); then spec + issue. Keep separate from #95
- [ ] Tern terminal button to toggle Echo mute + sound modes (Tern SDK). from Echo room, Oct 9. New feature request. Tern SDK research in progress, no brief yet. Mute toggles with one POST /mute; /mode has no toggle form yet
- [ ] OpenCode HIL announce (permission.asked). Regroup follow-up, no issue filed. Owner: Atlas
- [ ] Auto-quiet during desktop voice conversations. The Oct 7 plan is paused on two research questions (who holds the mic; how desktop-app events reach Echo). Owner: Atlas
- [ ] [#191](https://github.com/edheltzel/Echo/issues/191) Detect Herdr: stay as today if missing, talk to Herdr if present. Not started
- [ ] [#95](https://github.com/edheltzel/Echo/issues/95) Route Echo notifications through Herdr with pane-aware context and focus. Not started; separate from ATL-633
- [ ] [#96](https://github.com/edheltzel/Echo/issues/96) herdr socket api for agent types. Not started; assigned Atlas-Key
- [ ] [#194](https://github.com/edheltzel/Echo/issues/194) Jev seats: interrupt/duck, mute gate, wake vs ignore. Not started
- [ ] [#126](https://github.com/edheltzel/Echo/issues/126) Auto detect meetings. Not started; assigned Atlas-Key
- [ ] [#28](https://github.com/edheltzel/Echo/issues/28) Zero-touch UX: install/update without bash scripts or git. Not started
- [ ] [#8](https://github.com/edheltzel/Echo/issues/8) Publish NPM package for one-command install. Not started
- [ ] [#179](https://github.com/edheltzel/Echo/issues/179) Roadmap: first-class speech-to-text (STT). Backlogged idea
- [ ] [#180](https://github.com/edheltzel/Echo/issues/180) Roadmap/explore: VoiceBar-class macOS surface. Backlogged idea
- [ ] [#181](https://github.com/edheltzel/Echo/issues/181) Roadmap/explore: published documentation site. Backlogged idea
- [ ] [#195](https://github.com/edheltzel/Echo/issues/195) Roadmap/explore: VoiceStudio as a local edge-tts replacement. Backlogged idea, needs-triage


## Needs a check to confirm

- [ ] ATL-632 Grok as a speech provider (xAI TTS). On Oct 4 the xAI key "Echo" went into Echo's env file on BigMac, but there's no xAI/Grok TTS code on any GitHub branch and no issue. Check BigMac for local or uncommitted work
- [ ] [#106](https://github.com/edheltzel/Echo/issues/106) Publish playback state as a cross-process signal file. Branch cursor/fm-456-playback-state-6c32 (tip 1733444, Sep 10) is unmerged and the factory says awaiting-redteam, but the Oct 7 regroup says not started
- [ ] 8 baseline test failures on master. Reported in the #213 body (same 8 fail on clean master); no issue. Confirm they reproduce and who owns them
- [ ] Regroup doc branch docs/regroup-2026-10-07. Never merged to dev; check whether it was meant to land
- [ ] Installed daemon branch on BigMac. Sounds-only mode and /mode exist only on dev; confirm what BigMac runs before building the Tern button


## In progress

- [ ] [#213](https://github.com/edheltzel/Echo/pull/213) fix: keep test daemons' banners off the operator's screen. Open, mergeable (clean), adds ECHO_OSASCRIPT_BIN. Waiting on Ed's merge (or Atlas under the #212 low-risk rule)
- [ ] [#17](https://github.com/edheltzel/Echo/issues/17) Add OpenCode host adapter. The adapter ships on dev (#198/#199/#201/#204). Left: headless opencode run suppression (needs a live session) and the greeting-default decision (Ed)
- [ ] [#30](https://github.com/edheltzel/Echo/issues/30) [Epic] Make the voice system agent-agnostic. OpenCode is the last host; closes when #17 closes


## Candidates for closing

- [ ] FM-352 / FM-356 Pi extension finish + RedTeam review. Still "underway" in factory.db, but cursor/fm-352-pi-install-prove-72b2 is an ancestor of dev
- [ ] FM-353 Thin Claude Code plugin. Still "underway" in factory.db; merged as PR #176
- [ ] FM-365 Echo extension API / surface. Still "underway" in factory.db; merged as [#177](https://github.com/edheltzel/Echo/pull/177)
- [ ] Merged/duplicate remote branches. feat/notification-sounds, feat/install-onboarding-12, fix/test-preload-overrides, fix/test-xdg-leak (duplicate), docs/low-risk-merge-rule, feat/preview-voices-help-13, fix/registrar-dedupe-63, chore/resync-dev-with-master, chore/restore-master-ancestry, feat/opencode-adapter, fix/opencode-prune-config-plugin(-dev), cursor/fm-352, fm-365. Prune only after Ed confirms




%% kanban:settings
```
{"kanban-plugin":"board","list-collapse":[false,false,false,false]}
```
%%

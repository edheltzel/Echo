# To-do

Generated view of [todo.txt](todo.txt) (open tasks) and [done.txt](done.txt) (archive), managed with `tuxedo`. Synced 2026-11-16.

## Open

- [ ] 2026-10-09 **Waiting:** ATL-633 Daemon-owned notice (no name yet). on Ed to name the mechanism (not AppleScript, terminal, or Herdr); then spec + issue atl:633
- [ ] 2026-10-09 **Waiting:** Auto detect meetings. on Ed: needs a design (what is a meeting, who detects it, mute vs hold) issue:126
- [ ] 2026-10-09 Auto-quiet during desktop voice conversations. The Oct 7 plan is paused on two research questions (who holds the mic; how desktop-app events reach Echo). Owner: Atlas @outstanding
- [ ] 2026-10-23 **Waiting:** Merge PR #249 into dev (mute/mode for Jcode and Empryo). Pipeline test verdict inconclusive: host commands not driven live. Empryo $echo-mute verified live by hand; Jcode /echo-mute recognized but not run (Jcode has no working model login) on Ed Rebased onto dev 2026-11-16, CI green - [pr](https://github.com/edheltzel/Echo/pull/249)
- [ ] 2026-10-09 Tern terminal button to toggle Echo mute + sound modes (Tern SDK). from Echo room, Oct 9. New feature request. Tern SDK research in progress, no brief yet. Mute toggles with one POST /mute; /mode has no toggle form yet @outstanding due:2026-12-29
- [ ] 2026-10-09 **Waiting:** Zero-touch UX docs for non-developers. Waits on #8 (delivery half moved there) issue:28 on Ed's merge - [pr](https://github.com/edheltzel/Echo/pull/272)
- [ ] 2026-10-19 **Waiting:** ATL-642 Custom notification sounds. Config for custom audio files; play when a notification fires. Captain-hold until Echo is released. atl:642
- [ ] 2026-10-09 [Epic] Make the voice system agent-agnostic. OpenCode is the last host; closes when #17 closes @inprogress issue:30
- [ ] 2026-10-09 Add OpenCode host adapter. Shipped (#198/#204); greeting on by default (#219). Left: headless opencode run greeting check (needs a live session) @inprogress issue:17
- [ ] 2026-10-09 ATL-632 Grok as a speech provider (xAI TTS). On Oct 4 the xAI key "Echo" went into Echo's env file on BigMac, but there's no xAI/Grok TTS code on any GitHub branch and no issue. Check BigMac for local or uncommitted work @check atl:632
- [ ] 2026-10-09 Roadmap/explore: VoiceBar-class macOS surface. Backlogged idea @outstanding issue:180
- [ ] 2026-10-09 Roadmap/explore: VoiceStudio as a local edge-tts replacement. Backlogged idea, needs-triage @outstanding issue:195
- [ ] 2026-10-09 Roadmap: first-class speech-to-text (STT). Backlogged idea @outstanding issue:179
- [ ] 2026-10-15 Trial Pocket TTS through the Kokoro endpoint on an isolated daemon. Ed prefers Pocket TTS over KittenTTS; Supertonic is rejected
- [ ] 2026-10-17 **Waiting:** Decide promotion validation: #230's No Mistakes run was cancelled (pipeline rebases, breaking the merge commit). Ed to waive NM for dev-to-master promotions or name another promotion check - [pr](https://github.com/edheltzel/Echo/pull/230)
- [ ] 2026-10-19 Decide whether the /health limiter should stop trusting X-Forwarded-For and whether the daemon should bind localhost only Localhost bind answered by feat/notify-token-loopback (ATL-PINE-03a); X-Forwarded-For question still open
- [ ] 2026-10-19 Decide whether to silence plain claude -p sessions outside automation
- [ ] 2026-11-05 Add scripts/install.sh --list-installed (print each installed adapter, exit 0 before warn_if_linked_worktree) and tag a release, so GAP can pin it `note:/Users/ed/Developer/Atlas/GAP/docs/plans/2026-10-22-gap-breadcrumb-ledger-plan.md` branch feat/list-installed (c3453d4) in No Mistakes, PR into dev - [pr](https://github.com/edheltzel/Echo/pull/270)
- [ ] 2026-11-11 **Waiting:** ATL-PINE-03a notify token + 127.0.0.1 bind: branch feat/notify-token-loopback pushed, PR waits on Red-Team, then captain yes via AtlasX
- [ ] 2026-11-11 **Waiting:** Echo install via GAP: install.sh --list-installed + --adapter auto, tag, repin GAP on GAP component API being finished

## Done

- [x] 2026-11-16 6 local test failures on BigMac (bun test 2026-10-14): Claude plugin validate, runEchoMute, omp HIL announce, 2x Pi lifecycle, 1 integration override. Compare against clean dev; no issue - [change](adapters/claudecode/plugin/.claude-plugin/plugin.json)
- [x] 2026-11-16 Isolate HOME in pi/omp adapter tests: pi-adapter, pi-project-persona and omp-hil read the operator's real ~/.pi and ~/.omp daidentity and fail on a machine with a global persona - [change](adapters/pi/config.ts)
- [x] 2026-10-19 Add a no-mistakes axi --yes workflow line to AGENTS.md - [pr](https://github.com/edheltzel/Echo/pull/233)
- [x] 2026-10-19 Fix cli/echo --help backticks being evaluated by the shell - [pr](https://github.com/edheltzel/Echo/pull/233)
- [x] 2026-10-19 Fix cli/echo doctor reporting a /health 429 as a foreign port owner - [pr](https://github.com/edheltzel/Echo/pull/233)
- [x] 2026-10-19 Add the Empryo adapter (adapters/empryo, --adapter empryo, source empryo): greeting on desktop/tui, completion from the session event log, approval/question/plan-review announcements, headless silent, child tabs behind ECHO_VOICE_SUPPRESS_CHILD_TABS; Claude Code and Codex hooks stand down under Empryo - [adapter](adapters/empryo/README.md)
- [x] 2026-10-19 Document EMPRYO_HOOK_ENV=NO_MISTAKES_GATE so automation silence reaches Echo hooks under Empryo - [configuration](docs/configuration.md#schema-reference)
- [x] 2026-10-19 Merge #235 and #236, then cli/echo update and bun run restart - [pr](https://github.com/edheltzel/Echo/pull/235), [pr](https://github.com/edheltzel/Echo/pull/236)
- [x] 2026-10-19 Research Echo support for Empryo sessions (https://empryo.com/docs/). Possible through adapters/claudecode: Empryo already runs Echo's ~/.claude/settings.json hooks, but Stop reads Empryo's event log with the Claude transcript parser (empty result) and SessionStart sends source desktop/tui/headless, which the greeting skips. A separate adapters/empryo would double-fire - [pr](https://github.com/edheltzel/Echo/pull/241)
- [x] 2026-10-19 Verify an automation run stays silent on the live daemon. NO_MISTAKES_GATE=1 claude -p ran with no new echo.log delivery; omp -p is already silent in print mode
- [x] 2026-10-21 Re-publish fix/global-voice-fallback: PR #244 targeted master and its review commit stripped dev work. Closed #244, reset the remote branch to a5e1e6a, fixed the /echo-voice wording. Republishing against master with --base-branch dev so the dev work stays. - [pr](https://github.com/edheltzel/Echo/pull/244), [pr](https://github.com/edheltzel/Echo/pull/245)
- [x] 2026-10-21 Updated the local daemon to the staged 0.13.0 payload (versions/0.13.0, not a symlink to the checkout). com.echo healthy on :3246 - [report](https://github.com/edheltzel/Echo/releases/tag/v0.13.0)
- [x] 2026-10-21 v0.13.0 released: tag on master f800126, GitHub release published, dev resynced with merge commit 7469780 after squashed promotion #248 - [report](https://github.com/edheltzel/Echo/releases/tag/v0.13.0)
- [x] 2026-10-22 Echo mute/mode in every harness. Jcode: /echo-mute and /echo-mode skills. Empryo terminal UI: $echo-mute and $echo-mode skills (no user slash commands; Empryo issue dropped). Installed and verified on this Mac
- [x] 2026-10-22 Restarted com.echo. The staged 0.13.0 payload already matched the checkout file for file, so no re-stage was needed. New pid listens on :3246 and is healthy
- [x] 2026-10-23 Prune merged remote branches. 2026-10-22: deleted 35 branches fully merged into dev (ancestor, or merged PR whose head matches the branch tip). Left 10 unmerged: gitbutler/workspace, fm/release-v0.11.0, fm/echo-voiceask-v1-build-e12, fm/echo-voiceask-v1-fixes-b1, fm/echo-config-system-port-c1, feat/voice-serialization-plan, fix/opencode-prune-config-plugin (closed PRs), cursor/fm-456-playback-state-6c32, docs/regroup-2026-10-07, feat/opencode-adapter-v011 (no PR)
- [x] 2026-10-23 Publish npm package for one-command install. First published as atlas-echo, then renamed: agent-echo@0.13.3 is latest, v0.13.3 tagged on master, trusted publisher set for edheltzel/Echo publish.yml issue:8 - [pr](https://github.com/edheltzel/Echo/pull/259), [report](https://www.npmjs.com/package/agent-echo)
- [x] 2026-11-06 Roadmap/explore: published documentation site. Backlogged idea @outstanding issue:181 Shipped 2026-11-06 as site/ (Nimbus) at echo.edheltzel.codes via #267/#268
- [x] 2026-11-06 Migrate echo-site into Echo site/ with Nimbus. Shipped: PR #267 squash-merged into dev (e9dd27c), promoted in #268 (d1f172e on master). echo.edheltzel.codes now served by Pages project 'echo' (echo-dud.pages.dev, deployment 997da41c); old 'echo-site' builds disabled and echo-site-1ma.pages.dev 301s to the domain (ac006b5d); edheltzel/echo-site README updated and repo archived. Issue #181 (published docs site) can close issue:181 - [pr](https://github.com/edheltzel/Echo/pull/267), [pr](https://github.com/edheltzel/Echo/pull/268)
- [x] 2026-11-16 Clean up GitButler workspace: dropped empty stacks chore/release-0.13.1 and docs/readme-drop-note, deleted 17 merged local branches and 5 merged origin branches, unstaged stale index entries. Kept leftover-echo-start and leftover-pre-v011 (unmerged, no PR)

## Archived (done.txt)

- [x] 2026-10-15 Detect Herdr: stay as today if missing, talk to Herdr if present. Shipped in #133; documented in #215; #191 closed issue:191 - [pr](https://github.com/edheltzel/Echo/pull/215)
- [x] 2026-10-15 fix: keep test daemons' banners off the operator's screen. Merged as #213 - [pr](https://github.com/edheltzel/Echo/pull/213)
- [x] 2026-10-15 FM-352 / FM-356 Pi extension finish + RedTeam review. Merged as #174 - [pr](https://github.com/edheltzel/Echo/pull/174)
- [x] 2026-10-15 FM-353 Thin Claude Code plugin. Merged as #176 - [pr](https://github.com/edheltzel/Echo/pull/176)
- [x] 2026-10-15 FM-365 Echo extension API / surface. Merged as #177 - [pr](https://github.com/edheltzel/Echo/pull/177)
- [x] 2026-10-15 herdr socket api for agent types. Closed not planned; see docs/adapters.md for the upstream limitation issue:96 - [pr](https://github.com/edheltzel/Echo/pull/217)
- [x] 2026-10-15 Installed daemon branch on BigMac. Verified 2026-10-15: BigMac runs payload 0.12.0 with /mode
- [x] 2026-10-15 Jev seats: interrupt/duck, mute gate, wake vs ignore. Spike delivered in #220; #194 closed; verdicts in the #220 PR history issue:194 - [pr](https://github.com/edheltzel/Echo/pull/220)
- [x] 2026-10-15 OpenCode adapter: runtime persona & voice. Shipped in #204; #129 closed issue:129 - [pr](https://github.com/edheltzel/Echo/pull/204)
- [x] 2026-10-15 Promote dev → master. Merged as #223 - [pr](https://github.com/edheltzel/Echo/pull/223)
- [x] 2026-10-15 Publish playback state as a cross-process signal file. Shipped in #218; #106 closed issue:106 - [pr](https://github.com/edheltzel/Echo/pull/218)
- [x] 2026-10-15 Regroup doc branch docs/regroup-2026-10-07. Regroup record landed in #227; branch pruning remains in todo.txt - [pr](https://github.com/edheltzel/Echo/pull/227)
- [x] 2026-10-15 Route Echo notifications through Herdr with pane-aware context and focus. Herdr-first route shipped in #133; click-to-focus closed not planned; see docs/http-api.md for the limitation issue:95 - [pr](https://github.com/edheltzel/Echo/pull/216)
- [x] 2026-10-15 Promote dev to master for #226-#228. Squash-merged (not a merge commit); master ancestry restored by #231; No Mistakes run was cancelled after a failed test step, not passed - [pr](https://github.com/edheltzel/Echo/pull/230), [pr](https://github.com/edheltzel/Echo/pull/231)

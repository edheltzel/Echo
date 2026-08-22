<!-- markdownlint-disable MD024 -->
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](http://semver.org).

## [v0.10.0](https://github.com/edheltzel/Echo/tree/v0.10.0) - 2026-08-22

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.9.0...v0.10.0)

### Added

- Per-harness `install.sh --check` / `cli/echo doctor` report: one `Checking <name>` section with `[x]` / `[\]` / `[ ]` for LaunchAgent, workspace link, and adapter registration
- Contribution guide: working assumptions, required `verify` pre-merge gate, and doctor bootstrap

### Changed

- `verify` workflow now uses least-privilege permissions and fails closed if any check is skipped
- Local development verification list includes the Codex adapter build
- `package.json` version aligned with tagged releases (was stuck at 0.7.1 through v0.8.0 and v0.9.0)

## [v0.9.0](https://github.com/edheltzel/Echo/tree/v0.9.0) - 2026-08-19

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.8.0...v0.9.0)

### Other

- chore(release): promote dev to master (reliability fixes and subagent voice opt-in) [#159](https://github.com/edheltzel/Echo/pull/159) ([Atlas-Key](https://github.com/Atlas-Key))
- chore: restore master as ancestor of dev after #150 squash [#157](https://github.com/edheltzel/Echo/pull/157) ([Atlas-Key](https://github.com/Atlas-Key))
- feat(voice): opt in to subagent voice [#156](https://github.com/edheltzel/Echo/pull/156) ([Liona-orph](https://github.com/Liona-orph))
- fix: avoid stripping ordinary colon-led voice text [#155](https://github.com/edheltzel/Echo/pull/155) ([Liona-orph](https://github.com/Liona-orph))
- fix(claudecode): ignore fenced plain completion markers [#154](https://github.com/edheltzel/Echo/pull/154) ([Liona-orph](https://github.com/Liona-orph))
- test(core): cover voice resolution branches [#153](https://github.com/edheltzel/Echo/pull/153) ([Liona-orph](https://github.com/Liona-orph))
- test(core): harden architecture route and import scans [#152](https://github.com/edheltzel/Echo/pull/152) ([Liona-orph](https://github.com/Liona-orph))
- fix(core): label half-open provider failures honestly [#151](https://github.com/edheltzel/Echo/pull/151) ([Liona-orph](https://github.com/Liona-orph))

## [v0.8.0](https://github.com/edheltzel/Echo/tree/v0.8.0) - 2026-08-11

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.7.1...v0.8.0)

### Other

- chore(release): promote dev to master (Grok + Codex adapters) [#150](https://github.com/edheltzel/Echo/pull/150) ([Atlas-Key](https://github.com/Atlas-Key))
- feat(adapters): add Codex host adapter + Grok/Codex daidentity [#149](https://github.com/edheltzel/Echo/pull/149) ([Atlas-Key](https://github.com/Atlas-Key))
- feat(adapters): add first-class Grok Build host adapter [#148](https://github.com/edheltzel/Echo/pull/148) ([Atlas-Key](https://github.com/Atlas-Key))
- fix(adapters): preserve host method bindings [#146](https://github.com/edheltzel/Echo/pull/146) ([edheltzel](https://github.com/edheltzel))
- Promote dev: converse, config, and Jcode integration [#145](https://github.com/edheltzel/Echo/pull/145) ([edheltzel](https://github.com/edheltzel))
- feat: make ~/.config/echo/config.json authoritative for all Echo settings [#144](https://github.com/edheltzel/Echo/pull/144) ([edheltzel](https://github.com/edheltzel))
- style: replace em dashes with plain dashes across the repo [#142](https://github.com/edheltzel/Echo/pull/142) ([edheltzel](https://github.com/edheltzel))
- feat(converse): add voice-ask with per-session mic consent and playback-capture interlock [#141](https://github.com/edheltzel/Echo/pull/141) ([edheltzel](https://github.com/edheltzel))
- docs: archive completed plans and retired handoff under archive directories [#140](https://github.com/edheltzel/Echo/pull/140) ([edheltzel](https://github.com/edheltzel))
- docs(converse): document voice-ask setup and reconcile diverged dev/master histories [#139](https://github.com/edheltzel/Echo/pull/139) ([edheltzel](https://github.com/edheltzel))
- feat(converse): add echo-converse one-shot voice ask on :32468 [#138](https://github.com/edheltzel/Echo/pull/138) ([edheltzel](https://github.com/edheltzel))
- docs: document and verify native terminal notification behavior [#135](https://github.com/edheltzel/Echo/pull/135) ([edheltzel](https://github.com/edheltzel))
- docs(docs): sync triage-labels taxonomy across AGENTS.md and its doc [#134](https://github.com/edheltzel/Echo/pull/134) ([edheltzel](https://github.com/edheltzel))
- feat(shared): route Echo visual notifications through native terminal escape sequences [#133](https://github.com/edheltzel/Echo/pull/133) ([edheltzel](https://github.com/edheltzel))
- feat: move configuration to ~/.config/echo/config.json and default to port 3246 [#132](https://github.com/edheltzel/Echo/pull/132) ([edheltzel](https://github.com/edheltzel))
- feat(cli): run the daemon from a clone-independent payload and add the echo CLI [#131](https://github.com/edheltzel/Echo/pull/131) ([edheltzel](https://github.com/edheltzel))
- fix(core): resolve daemon env config without hydrating process.env [#124](https://github.com/edheltzel/Echo/pull/124) ([edheltzel](https://github.com/edheltzel))
- fix(adapters): make host adapters self-contained and HTTP-only [#123](https://github.com/edheltzel/Echo/pull/123) ([edheltzel](https://github.com/edheltzel))

## [v0.7.1](https://github.com/edheltzel/Echo/tree/v0.7.1) - 2026-07-21

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.7.0...v0.7.1)

### Other

- fix(voice): announce the project persona name in the startup greeting [#121](https://github.com/edheltzel/Echo/pull/121) ([edheltzel](https://github.com/edheltzel))
- release: v0.7.0 — /echo-voice persona scaffold for pi & omp [#120](https://github.com/edheltzel/Echo/pull/120) ([edheltzel](https://github.com/edheltzel))

## [v0.7.0](https://github.com/edheltzel/Echo/tree/v0.7.0) - 2026-07-21

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.6.0...v0.7.0)

### Other

- fix(shared): defer Bun.YAML access in persona-scaffold (pi/omp load crash) [#119](https://github.com/edheltzel/Echo/pull/119) ([edheltzel](https://github.com/edheltzel))
- feat(pi,omp): /echo-voice persona scaffold command [#118](https://github.com/edheltzel/Echo/pull/118) ([edheltzel](https://github.com/edheltzel))
- chore(release): v0.6.0 — per-project persona & voice [#117](https://github.com/edheltzel/Echo/pull/117) ([edheltzel](https://github.com/edheltzel))

## [v0.6.0](https://github.com/edheltzel/Echo/tree/v0.6.0) - 2026-07-20

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.5.0...v0.6.0)

### Other

- feat(omp): dedicated reconcile + installer wiring, migrate off adapters/pi (#109) [#116](https://github.com/edheltzel/Echo/pull/116) ([edheltzel](https://github.com/edheltzel))
- feat(omp): dedicated adapter + native-config persona override (#109 slice) [#115](https://github.com/edheltzel/Echo/pull/115) ([edheltzel](https://github.com/edheltzel))
- feat(pi): per-project persona & voice via .pi/settings.json daidentity [#113](https://github.com/edheltzel/Echo/pull/113) ([edheltzel](https://github.com/edheltzel))
- feat: project-directory persona & voice override (#111) [#112](https://github.com/edheltzel/Echo/pull/112) ([edheltzel](https://github.com/edheltzel))
- chore(readme): riso-style banner [#105](https://github.com/edheltzel/Echo/pull/105) ([edheltzel](https://github.com/edheltzel))

## [v0.5.0](https://github.com/edheltzel/Echo/tree/v0.5.0) - 2026-07-13

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.4.1...v0.5.0)

### Other

- release: v0.5.0 — capture guard, play-queue hardening, CI gate, instant catchphrase [#104](https://github.com/edheltzel/Echo/pull/104) ([edheltzel](https://github.com/edheltzel))
- chore(release): v0.5.0 [#103](https://github.com/edheltzel/Echo/pull/103) ([edheltzel](https://github.com/edheltzel))
- feat(core): capture guard — hold voice lines while an external mic capture is live [#101](https://github.com/edheltzel/Echo/pull/101) ([edheltzel](https://github.com/edheltzel))
- feat(core): play-queue hardening — dispositions, coalescing, age cap, watchdog (salvaged from #92) [#100](https://github.com/edheltzel/Echo/pull/100) ([edheltzel](https://github.com/edheltzel))
- ci: machine-run the verification trio on PRs and pushes to dev/master [#99](https://github.com/edheltzel/Echo/pull/99) ([edheltzel](https://github.com/edheltzel))
- 202-on-receipt + serial play-queue + TTS cache: instant startup catchphrase (#202) [#97](https://github.com/edheltzel/Echo/pull/97) ([edheltzel](https://github.com/edheltzel))
- fix(pi): honor Echo config for adapter identity [#93](https://github.com/edheltzel/Echo/pull/93) ([edheltzel](https://github.com/edheltzel))
- docs: make playback overlap the first-class Phase 2 target [#90](https://github.com/edheltzel/Echo/pull/90) ([edheltzel](https://github.com/edheltzel))
- feat: voice playback observability (Phase 1 — log before fix) [#89](https://github.com/edheltzel/Echo/pull/89) ([edheltzel](https://github.com/edheltzel))

## [v0.4.1](https://github.com/edheltzel/Echo/tree/v0.4.1) - 2026-07-06

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.4.0...v0.4.1)

### Other

- dev [#88](https://github.com/edheltzel/Echo/pull/88) ([edheltzel](https://github.com/edheltzel))

## [v0.4.0](https://github.com/edheltzel/Echo/tree/v0.4.0) - 2026-07-06

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.3.1...v0.4.0)

### Other

- dev [#87](https://github.com/edheltzel/Echo/pull/87) ([edheltzel](https://github.com/edheltzel))
- fix(core): keep Edge TTS health diagnostic-only [#86](https://github.com/edheltzel/Echo/pull/86) ([edheltzel](https://github.com/edheltzel))
- docs: human-friendly documentation pass (snapshot + conformance/accuracy refinement) [#85](https://github.com/edheltzel/Echo/pull/85) ([edheltzel](https://github.com/edheltzel))
- feat: runtime mute — global switch (timed/indefinite) via /mute + mute.sh + hotkey contract (#83) [#84](https://github.com/edheltzel/Echo/pull/84) ([edheltzel](https://github.com/edheltzel))
- feat(pi): startup catchphrase pool + en-GB-RyanNeural voice at -8% rate (#81) [#82](https://github.com/edheltzel/Echo/pull/82) ([edheltzel](https://github.com/edheltzel))
- feat: oh-my-pi (omp) support via shared Pi adapter (#18) [#80](https://github.com/edheltzel/Echo/pull/80) ([edheltzel](https://github.com/edheltzel))
- Reconcile ALL host adapter registrations — prune stale repo paths after a directory rename (#77) [#79](https://github.com/edheltzel/Echo/pull/79) ([edheltzel](https://github.com/edheltzel))
- feat(pi): distinct Pi persona voice — en-US-GuyNeural (#76) [#78](https://github.com/edheltzel/Echo/pull/78) ([edheltzel](https://github.com/edheltzel))
- Capitalize brand name echo → Echo in documentation prose [#75](https://github.com/edheltzel/Echo/pull/75) ([edheltzel](https://github.com/edheltzel))
- chore(release): promote dev → master as v0.3.1 (Echo rename) [#74](https://github.com/edheltzel/Echo/pull/74) ([edheltzel](https://github.com/edheltzel))

## [v0.3.1](https://github.com/edheltzel/Echo/tree/v0.3.1) - 2026-07-01

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.3.0...v0.3.1)

### Other

- chore(release): promote dev → master as v0.3.1 (Echo rename) [#74](https://github.com/edheltzel/Echo/pull/74) ([edheltzel](https://github.com/edheltzel))
- refactor: rename project Atlas Voicesystem → Echo [#73](https://github.com/edheltzel/Echo/pull/73) ([edheltzel](https://github.com/edheltzel))
- dev [#72](https://github.com/edheltzel/Echo/pull/72) ([edheltzel](https://github.com/edheltzel))
- docs(changelog): fix v0.3.0 footer compare-links + release date [#71](https://github.com/edheltzel/Echo/pull/71) ([edheltzel](https://github.com/edheltzel))
- docs(changelog): fix v0.3.0 footer compare-links + release datef [#70](https://github.com/edheltzel/Echo/pull/70) ([edheltzel](https://github.com/edheltzel))
- docs: rebrand Atlas Voicesystem → Atlas Echo [#69](https://github.com/edheltzel/Echo/pull/69) ([edheltzel](https://github.com/edheltzel))
- docs(changelog): fix v0.3.0 footer compare-links + release date [#68](https://github.com/edheltzel/Echo/pull/68) ([edheltzel](https://github.com/edheltzel))
- docs(changelog): fix v0.3.0 footer compare-links + release date [#67](https://github.com/edheltzel/Echo/pull/67) ([edheltzel](https://github.com/edheltzel))
- Release v0.3.0 — promote dev to master (#59 + bump) [#66](https://github.com/edheltzel/Echo/pull/66) ([edheltzel](https://github.com/edheltzel))

## [v0.3.0](https://github.com/edheltzel/Echo/tree/v0.3.0) - 2026-06-28

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.2.0...v0.3.0)

### Other

- Release v0.3.0 — promote dev to master (#59 + bump) [#66](https://github.com/edheltzel/Echo/pull/66) ([edheltzel](https://github.com/edheltzel))
- chore(release): v0.3.0 [#64](https://github.com/edheltzel/Echo/pull/64) ([edheltzel](https://github.com/edheltzel))
- refactor(#59): rename adapters/pai → adapters/claudecode + de-PAI public surface [#62](https://github.com/edheltzel/Echo/pull/62) ([edheltzel](https://github.com/edheltzel))
- Release v0.2.0 — retire legacy PAI stow tree [#61](https://github.com/edheltzel/Echo/pull/61) ([edheltzel](https://github.com/edheltzel))

## [v0.2.0](https://github.com/edheltzel/Echo/tree/v0.2.0) - 2026-06-27

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.1.1...v0.2.0)

### Other

- Release v0.2.0 — retire legacy PAI stow tree [#61](https://github.com/edheltzel/Echo/pull/61) ([edheltzel](https://github.com/edheltzel))
- fix(#1): retire legacy PAI stow tree (Workstream A) [#60](https://github.com/edheltzel/Echo/pull/60) ([edheltzel](https://github.com/edheltzel))
- Release: promote v0.1.1 to master (agent-first legibility + enforcement) [#58](https://github.com/edheltzel/Echo/pull/58) ([edheltzel](https://github.com/edheltzel))

## [v0.1.1](https://github.com/edheltzel/Echo/tree/v0.1.1) - 2026-06-24

[Full Changelog](https://github.com/edheltzel/Echo/compare/v0.1.0...v0.1.1)

### Other

- chore(release): bump version 0.1.0 → 0.1.1 [#57](https://github.com/edheltzel/Echo/pull/57) ([edheltzel](https://github.com/edheltzel))
- docs: agent-first legibility restructure (Worker A) [#56](https://github.com/edheltzel/Echo/pull/56) ([edheltzel](https://github.com/edheltzel))
- test(core): enforce architecture invariants as CI-failing tests [#54](https://github.com/edheltzel/Echo/pull/54) ([edheltzel](https://github.com/edheltzel))
- Release: promote v0.1.0 to master (version + CHANGELOG + DOX) [#53](https://github.com/edheltzel/Echo/pull/53) ([edheltzel](https://github.com/edheltzel))

## [v0.1.0](https://github.com/edheltzel/Echo/tree/v0.1.0) - 2026-06-24

[Full Changelog](https://github.com/edheltzel/Echo/compare/2a05a40471e1b3d3cda5c28b2999aa41130524d0...v0.1.0)

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Voice playback serialization (Phase 2)**: a global serial play queue in the daemon
  (`core/play-queue.ts`) — one voice at a time across all sessions and hosts, the in-flight
  line never interrupted. Queued lines coalesce newest-per-session and age out past
  `ECHO_PLAY_QUEUE_AGE_CAP_MS` (depth-capped by `ECHO_PLAY_QUEUE_MAX_DEPTH`); every line's
  outcome lands in the audio-lifecycle log as a `disposition`
  (`played`/`superseded`/`dropped-stale`).

### Changed
- **`/notify` (and `/notify/personality`) now ack `202` on receipt** instead of `200` after
  playback: callers unblock in milliseconds while synthesis and playback run from the queue.
  Compatibility: still 2xx (`response.ok` true), so existing callers are unaffected; true
  playback outcome now lives in the audio-lifecycle log (see `docs/http-api.md`).
- Clarified README and troubleshooting docs for Edge TTS diagnostic-only health checks,
  resolution-log provider diagnostics, and macOS `say` fallback investigation.
- Documented local development worktree cleanup and ignored `.worktrees/` so temporary
  feature worktrees are not reported as untracked project files.

## [0.4.0] - 2026-07-06

### Fixed
- **Edge TTS fallback regression hardening**: `/notify` no longer lets the diagnostic
  `python -c "import edge_tts"` health probe veto Edge TTS and fall through to macOS `say`.
  Edge is skipped only when disabled or when its circuit breaker is open from real synthesis
  failures. Edge synthesis now logs structured phase/reason/elapsed/timeout/exit/stderr
  diagnostics, serializes synthesis attempts to reduce concurrent-process flakiness, and uses
  an adaptive timeout (`base + per-character`, capped) so longer messages do not hit the same
  fixed budget as short probes.

### Changed
- **Human-friendly documentation overhaul**: `README.md` slimmed to landing + quickstart +
  routing (accurate `/notify` defaults, no more `"voice_id":"atlas"` example);
  `docs/voices.md` is now the single voice home (resolution order, audition commands + flag
  table, self-service how-tos incl. ElevenLabs setup); `docs/http-api.md` documents the full
  `/notify` contract (all fields optional); install docs cover `--adapter omp`, exact
  expected outputs, and the uninstall/deregistration caveat; `CONTRIBUTING.md` gains
  branching/release rules and the #77 adapter-registration pointer; duplicated voice
  audition copies in README/`docs/install-human.md`/`docs/development.md` reduced to
  pointers. Follow-up pass: day-to-day mute usage (`scripts/mute.sh`) moved from
  `docs/http-api.md` to `docs/operations.md` and `ECHO_MUTE_STATE_PATH` documented in
  `docs/configuration.md` (#84 follow-up; the `/mute` endpoint contract + hotkey bindings
  stay in `docs/http-api.md`); the deprecated env-name mapping/migration moved from
  `README.md` to `docs/configuration.md` (README keeps a pointer); README gains the
  `/mute` endpoint and the mute lifecycle command; oh-my-pi (omp) is now named alongside
  Pi in README/`ARCHITECTURE.md`/getting-started prose.
- **Pi/omp startup greeting pool + voice retune** (#81): the shared Pi adapter now greets
  each user-visible `session_start` with a random pick from a pool of neutral catchphrases
  (mirroring the Claude Code adapter's `startupCatchphrases` mechanism) instead of the single
  static "Pi session ready."; setting `ECHO_VOICE_CATCHPHRASE` (or the legacy
  `ATLAS_VOICE_CATCHPHRASE`) pins the greeting to that one line. The shared `pi` voice entry
  in `core/voices.json` changes to `en-GB-RyanNeural` at speed `0.92` (edge-tts rate `-8%`);
  the never-read `agents.pi.catchphrase` field is removed (dead data — core never reads
  `catchphrase`, and the greeting now lives in the adapter pool). Data-only `core/` change;
  a running daemon loads `voices.json` once at startup, so restart it
  (`launchctl kickstart -k "gui/$UID/com.echo"`) to pick up the new voice.
- The installer now re-reconciles **every installed adapter registration on every run**,
  regardless of `--adapter`, so a repo directory rename heals with one rerun (#77).
- `adapters/claudecode/restore-hooks.ts` prunes stale foreign-clone Voice hook registrations
  (non-canonical `*/adapters/claudecode/hooks/Voice*.hook.ts` paths left by a rename) (#77).
- `docs/adapters.md` documents the mandatory reconcile-and-prune registration contract for
  all current and future adapters (#77).
- Capitalized the project display name to **Echo** in documentation/marketing prose only
  (headings and descriptive text). Code, CLI/daemon output, command examples, the package
  name `echo`, service label `com.echo`, and paths are unchanged.

### Added
- **Runtime mute** (#83): one global mute switch on the daemon — `POST /mute` (explicit
  JSON body sets state; an **empty body toggles**, hotkey-friendly) plus
  `scripts/mute.sh on [minutes] | off | toggle | status`. Muted notifications are processed
  and logged normally (echo.log + resolution drop-off log carry a `muted` marker); audio
  alone is suppressed across every provider **including the macOS `say` fallback**, via one
  gate before the provider loop. Mute is indefinite or timed (`duration_minutes`); timed
  mutes expire lazily and silently. State survives daemon restarts with its deadline intact
  in a user-owned `mute.json` (atomic writes; missing/corrupt file = unmuted; path override
  `ECHO_MUTE_STATE_PATH`). `GET /health` exposes an additive `mute` block. Hotkey binding
  examples (Raycast / Shortcuts / Stream Deck) in [docs/http-api.md](docs/http-api.md).
- **New docs**: `docs/getting-started.md` (beginner tutorial, first install → first spoken
  notification), `docs/operations.md` (start/stop/restart/status, update-after-pull,
  repo-move recovery, logs, uninstall), and `docs/configuration.md` (env files,
  `ECHO_ENV_PATHS`, `PORT`, `voices.json`/`pronunciations.json` reference).
- **oh-my-pi (omp) support** (#18): the Pi adapter now serves both upstream Pi and the
  oh-my-pi fork. `before_agent_start` voice-line injection handles omp's `string[]`
  `systemPrompt` shape (upstream stays `string`), and `bash scripts/install.sh --adapter omp`
  registers the adapter via `adapters/pi/reconcile-omp.ts` — an idempotent
  reconcile-and-prune symlink (`~/.omp/agent/extensions/echo-voice` → `adapters/pi/`) per the
  #77 contract with strict ownership (only the `echo-voice` name is ever touched, healed
  only for provably-Echo targets, FATAL exit 2 otherwise), `--check` exiting 0 current /
  3 pending / 2 fatal, and a preflight that surfaces FATAL states before any host mutation.
  omp uses the same `pi` voice and persona as upstream Pi.
- **Pi adapter distinct persona voice** (#76): new `pi` entry in `core/voices.json`
  (`en-US-GuyNeural` / kokoro `am_puck`); the Pi adapter now defaults `voice_id` to `"pi"`
  (override via `ECHO_VOICE_ID`) and `personaName` to `"Pi"` (override via
  `ECHO_VOICE_PERSONA_NAME`), so Pi sessions sound distinct from the default identity voice.
  A running daemon loads `voices.json` once at startup — restart it
  (`launchctl kickstart -k "gui/$UID/com.echo"`) so the new `pi` entry resolves.
- `adapters/pi/reconcile.ts`: idempotent Pi registration reconcile — replaces stale
  `*/adapters/pi` packages entries with the canonical path in place, collapses duplicates,
  supports `--check`, and writes through a symlinked `~/.pi/agent/settings.json` without
  replacing the symlink (#77).
- `scripts/install.sh --check`: reports dead echo-related paths across `com.echo.plist`,
  `~/.claude/settings.json`, and `~/.pi/agent/settings.json` without mutating; exits 0 when
  current, 3 when staleness was detected (adapter `--check` modes use the same codes) (#77).

## [0.3.1] - 2026-07-01

Renamed the project **Atlas Voicesystem → Echo** (Ed's call — "Atlas" is personal). A full
de-brand across the brand/display name, the GitHub repo slug (`edheltzel/echo`), package names
(`echo`, `@echo/pi-adapter`), default filesystem paths, the LaunchAgent label, and the
environment-variable knobs. The persona-name default (`Atlas`) is unchanged.

**Versioning note:** the Breaking items below change the install contract (LaunchAgent label and
default filesystem paths) and would normally warrant a major bump; they ship under a patch bump
(0.3.0 → 0.3.1) by maintainer decision, since the installer migrates a running service
automatically and no released consumer depends on the old label or paths.

### Breaking

- **LaunchAgent label** renamed `com.atlas.voicesystem` → `com.echo` (plist
  `~/Library/LaunchAgents/com.echo.plist`). A reinstall (`bash scripts/install.sh`) migrates
  automatically: the installer now unloads and quarantines a running `com.atlas.voicesystem`
  (alongside the existing `com.pai.voice-server` handling) before loading `com.echo`.
- **Default filesystem paths** moved from `…/atlas-voicesystem/…` → `…/echo/…`: log
  `~/Library/Logs/echo.log`, config dir `~/.config/echo/.env`, audio cache
  `~/Library/Caches/echo/audio`, drop-off log `~/Library/Logs/echo/voice-resolution.jsonl`.
  Old logs/config/cache are orphaned (harmless) — copy them over if you want history.

### Changed

- Project renamed **Atlas Voicesystem → Echo** across all brand/display text, the GitHub repo
  slug (`edheltzel/atlas-voicesystem` → `edheltzel/echo`), and package names (root `echo`,
  Pi adapter `@echo/pi-adapter`).

### Deprecated

- Environment-variable knobs renamed to a `ECHO_*` canonical scheme. The former `ATLAS_VOICE_*`
  (Pi adapter) and `VOICESYSTEM_*` (core) names **still work as silent fallbacks** but are
  deprecated and slated for removal in a future major. The canonical name is read first; old
  names are the fallback. See the README's **"Deprecated environment variables"** section for the
  full old→new mapping (23 names, two convergences) and migration directions.

## [0.3.0] - 2026-06-29

Rename the Claude Code adapter and neutralize the public PAI surface (#59). `core/` was already
host-neutral; this completes the public, PAI-independent repo. Pi adapter untouched.

### Breaking

- Renamed the Claude Code adapter `adapters/pai` → `adapters/claudecode`. The install flag is now
  `--adapter claudecode` (was `--adapter pai`). **Existing installs must repoint:** re-run
  `bash scripts/install.sh --adapter claudecode`, or update the three voice hook command paths in
  `~/.claude/settings.json` from `adapters/pai/hooks/` to `adapters/claudecode/hooks/`.
- `NotifyPayload.source` emitted by the Claude Code adapter changed from `'pai'` to `'claudecode'`
  (parity with the Pi adapter's `'pi'`). Affects only the human-readable log annotation; no
  consumer branches on the value.

### Changed

- Stripped the legacy/historical hook-registration machinery from the adapter registrar
  (`restore-hooks.ts`); it now knows only `adapters/claudecode/hooks/*` and registers idempotently.
  The reconciliation now de-dupes within a matcher block (`.find()` → `.filter()`).
- Default adapter identity is now neutral (`'Assistant'`), with `identity.ts` as the single source
  of truth (removed hardcoded DA-name fallbacks).
- De-PAI'd the public documentation surface (README, AGENTS.md, ARCHITECTURE.md, docs/*).

### Removed

- `MIGRATIONS.md` — documented a private PAI integration; `CHANGELOG.md` serves public releases.

### Added

- Guard test (`tests/core/architecture-invariants.test.ts`, Invariant 6): no tracked `adapters/pai/`
  path and no `--adapter pai` in the installer, so the old adapter name cannot return.

## [0.2.0] - 2026-06-25

Retire the legacy PAI stow tree; host integration is adapter-only. The adapter rename and full
PAI de-brand are tracked separately in #59.

### Added

- Guard test (`tests/core/architecture-invariants.test.ts`, Invariant 5) pinning the retirement
  so the legacy `claudecode/.claude/PAI/USER/Voice/` tree cannot return.

### Changed

- `adapters/pai/restore-hooks.ts` now migrates legacy `VoiceGate`/`VoiceGreeting` hook
  registrations to the adapter paths idempotently.

### Removed

- Legacy PAI stow tree `claudecode/.claude/PAI/USER/Voice/` (20 files) retired (#1).

## [0.1.1] - 2026-06-24

Agent-first repository legibility + mechanical enforcement. No runtime behavior change.

### Added

- `ARCHITECTURE.md` (codemap, boundaries, invariants) and `SECURITY.md` (trust boundary, egress posture, secret handling).
- `docs/` progressive-disclosure tree — `http-api.md`, `adapters.md`, `providers-observability.md`, `reliability.md`, `voices.md`, `dox.md`, and `design-docs/` (index + pi-completion-injection).
- Mechanical enforcement: `tests/core/architecture-invariants.test.ts` — fails CI if `core/` imports a host/adapter API, references `:31337`, uses a `/tmp` process path, or adds a host-named route.

### Changed

- `AGENTS.md` slimmed to a lean entry point (~130 lines) with detail relocated into `docs/` (DOX procedure → `docs/dox.md`; contract preserved).

## [0.1.0] - 2026-06-23

Initial release of the universal voice-system core plus PAI and Pi host adapters.

### Added

- Persona-aware per-turn voice — personas speak in their own voice, their own words, and show their own name in the notification title (#27, #31, #33).
- Provider egress gating, proven and auditable via `/health` (`wouldEgress`/`egressTarget`); a disabled provider makes zero outbound calls (#26).
- Provider circuit breaker with correct synth-vs-playback failure attribution and env-tunable thresholds/timeouts (#25).
- Structured, size-capped voice-resolution drop-off log (JSONL) for diagnosing why a notify used a given voice (#24).
- Pi adapter speaks per-turn completions by injecting the `🗣️` convention via `before_agent_start`; configurable persona name via `ATLAS_VOICE_PERSONA_NAME` (#15).
- Installer wires the Stop hook idempotently (#34).

### Fixed

- CRLF-safe and fence-aware legacy completion fallbacks (#36).
- Deflaked `resolution-log` test under parallel `bun test` (#47).

### Tests

- Behavioral edge-tts synth/playback attribution test (#38); egress-gating, circuit-breaker, env-parsing, and persona-resolution coverage.

[Unreleased]: https://github.com/edheltzel/echo/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/edheltzel/echo/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/edheltzel/echo/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/edheltzel/echo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/edheltzel/echo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/edheltzel/echo/releases/tag/v0.1.1
[0.1.0]: https://github.com/edheltzel/echo/releases/tag/v0.1.0

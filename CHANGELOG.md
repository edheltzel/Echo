# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Capitalized the project display name to **Echo** in documentation/marketing prose only
  (headings and descriptive text). Code, CLI/daemon output, command examples, the package
  name `echo`, service label `com.echo`, and paths are unchanged.

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

[Unreleased]: https://github.com/edheltzel/echo/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/edheltzel/echo/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/edheltzel/echo/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/edheltzel/echo/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/edheltzel/echo/releases/tag/v0.1.1
[0.1.0]: https://github.com/edheltzel/echo/releases/tag/v0.1.0

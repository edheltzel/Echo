# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/edheltzel/atlas-voicesystem/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/edheltzel/atlas-voicesystem/releases/tag/v0.1.0

# Dependency Graph

`atlas-voicesystem` separates the voice server core from optional host adapters and optional TTS providers.

## Required

| Dependency | Why | Notes |
|---|---|---|
| Bun | Runs TypeScript server and scripts | Verified with Bun 1.3.x |
| macOS | LaunchAgent and `afplay`/`say` support | Linux is best-effort for manual server runs only |
| One enabled TTS provider | Audio output | The default config enables edge-tts and macOS `say` fallback on macOS |

## Optional providers

| Provider | Cost | Requirements | Behavior when absent |
|---|---|---|---|
| edge-tts | Free | Python at `/opt/homebrew/bin/python3` with `edge_tts` module | Circuit breaker skips to next provider |
| ElevenLabs | Paid/cloud | `ELEVENLABS_API_KEY` and provider enabled in `voices.json` | Disabled by default; skipped when no key |
| Kokoro | Free/local | Local Kokoro-compatible server on `127.0.0.1:8880` | Disabled by default; skipped when unhealthy |
| macOS `say` | Free/local | macOS | Terminal fallback when enabled |

## Optional host adapters

| Host | Path | Status | Install |
|---|---|---|---|
| None / direct HTTP | core only | Supported | POST JSON to `/notify` |
| Claude Code | `adapters/claudecode/` | Reference adapter | `bash scripts/install.sh --adapter claudecode` |
| Pi | `adapters/pi/` | First non-Claude-Code adapter | `bash scripts/install.sh --adapter pi` or `pi install ./adapters/pi` |
| OpenCode | TBD | Planned | Future adapter |

## Decision matrix

| Goal | Install |
|---|---|
| Minimum local server | Bun + `bash scripts/install.sh --adapter none` |
| Existing Claude Code workflow | Bun + Claude Code + `bash scripts/install.sh --adapter claudecode` |
| Pi voice lifecycle | Bun + Pi + `bash scripts/install.sh --adapter pi` |
| Fully local speech | Bun + edge-tts or Kokoro + macOS fallback |
| Cloud premium voice | Bun + ElevenLabs key + ElevenLabs enabled in config |

See `README.md` for architecture and `docs/install-agent.md` for command-by-command verification.

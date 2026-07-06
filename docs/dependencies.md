# Dependency Graph

`echo` separates the voice server core from optional host adapters and optional TTS providers.

## Required

| Dependency | Why | Notes |
|---|---|---|
| Bun | Runs TypeScript server and scripts | Verified with Bun 1.3.x |
| macOS | LaunchAgent and `afplay`/`say` support | Linux is best-effort for manual server runs only |
| One enabled TTS provider | Audio output | The default config enables edge-tts and macOS `say` fallback on macOS |

## Optional providers

| Provider | Cost | Requirements | Behavior when absent |
|---|---|---|---|
| edge-tts | Free | Python at `/opt/homebrew/bin/python3` with `edge_tts` module | Synthesis failure is logged with diagnostics, then fallback; repeated real failures open the circuit breaker |
| ElevenLabs | Paid/cloud | `ELEVENLABS_API_KEY` and provider enabled in `voices.json` | Disabled by default; skipped when no key |
| Kokoro | Free/local | Local Kokoro-compatible server on `127.0.0.1:8880` | Disabled by default; skipped when unhealthy |
| macOS `say` | Free/local | macOS | Terminal fallback when enabled |

### Installing optional providers

- **edge-tts** — the daemon invokes `/opt/homebrew/bin/python3 -m edge_tts` (the path is fixed in `core/server.ts`), so the `edge_tts` module must be importable by that exact interpreter — a different `python3` on your PATH or a pipx install does not count:

  ```bash
  /opt/homebrew/bin/python3 -m pip install edge-tts
  # If Homebrew's Python refuses with "externally-managed-environment":
  /opt/homebrew/bin/python3 -m pip install --break-system-packages edge-tts
  ```

  Without it, notifications still speak — Edge synthesis fails with diagnostics and the chain falls back to macOS `say`, which uses a noticeably different voice. If you hear the wrong voice, check the latest `attempts[]` in `~/Library/Logs/echo/voice-resolution.jsonl`; `phase:"synthesis"` plus Python stderr usually points here.

- **ElevenLabs** — nothing to install locally. Set `ELEVENLABS_API_KEY` in an env file the daemon reads, enable the provider in `core/voices.json`, then restart the daemon.

- **Kokoro** — run any Kokoro-compatible server on `127.0.0.1:8880` (default endpoint `http://127.0.0.1:8880/v1`), enable the provider in `core/voices.json`, then restart the daemon.

- **macOS `say`** — built into macOS; nothing to install.

## Optional host adapters

| Host | Path | Status | Install |
|---|---|---|---|
| None / direct HTTP | core only | Supported | POST JSON to `/notify` |
| Claude Code | `adapters/claudecode/` | Reference adapter | `bash scripts/install.sh --adapter claudecode` |
| Pi | `adapters/pi/` | First non-Claude-Code adapter | `bash scripts/install.sh --adapter pi` or `pi install ./adapters/pi` |
| oh-my-pi (omp) | `adapters/pi/` (shared) | Supported — same adapter, dual-shape `before_agent_start` | `bash scripts/install.sh --adapter omp` |
| OpenCode | TBD | Planned | Future adapter |

## Decision matrix

| Goal | Install |
|---|---|
| Minimum local server | Bun + `bash scripts/install.sh --adapter none` |
| Existing Claude Code workflow | Bun + Claude Code + `bash scripts/install.sh --adapter claudecode` |
| Pi voice lifecycle | Bun + Pi + `bash scripts/install.sh --adapter pi` |
| oh-my-pi voice lifecycle | Bun + omp + `bash scripts/install.sh --adapter omp` |
| Fully local speech | Bun + edge-tts or Kokoro + macOS fallback |
| Cloud premium voice | Bun + ElevenLabs key + ElevenLabs enabled in config |

See `README.md` for architecture and `docs/install-agent.md` for command-by-command verification.

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

- **edge-tts** - the daemon invokes `/opt/homebrew/bin/python3 -m edge_tts` (the path is fixed in `core/server.ts`), so the `edge_tts` module must be importable by that exact interpreter - a different `python3` on your PATH or a pipx install does not count:

  ```bash
  /opt/homebrew/bin/python3 -m pip install edge-tts
  # If Homebrew's Python refuses with "externally-managed-environment":
  /opt/homebrew/bin/python3 -m pip install --break-system-packages edge-tts
  ```

  Without it, notifications still speak - Edge synthesis fails with diagnostics and the chain falls back to macOS `say`, which uses a noticeably different voice. If you hear the wrong voice, check the latest `attempts[]` in `~/Library/Logs/echo/voice-resolution.jsonl`; `phase:"synthesis"` plus Python stderr usually points here.

- **ElevenLabs** - nothing to install locally. Set `ELEVENLABS_API_KEY` in an env file the daemon reads, enable the provider in `core/voices.json`, then run `cli/echo update` (a plain restart does not pick up a `voices.json` edit - see `docs/operations.md`).

- **Kokoro** - run any Kokoro-compatible server on `127.0.0.1:8880` (default endpoint `http://127.0.0.1:8880/v1`), enable the provider in `core/voices.json`, then run `cli/echo update`.

- **macOS `say`** - built into macOS; nothing to install.

## Optional host adapters

| Host | Path | Status | Install |
|---|---|---|---|
| None / direct HTTP | core only | Supported | POST JSON to `/notify` |
| Claude Code | `adapters/claudecode/` | Reference adapter | `bash scripts/install.sh --adapter claudecode` |
| Pi | `adapters/pi/` | First non-Claude-Code adapter | `bash scripts/install.sh --adapter pi` or `pi install ./adapters/pi` |
| oh-my-pi (omp) | `adapters/omp/` | Supported - sibling package to the Pi adapter (#109) | `bash scripts/install.sh --adapter omp` |
| MCP (Claude Code voice ask) | `adapters/mcp/` | Supported - serves the `echo_ask` tool over stdio | `bash scripts/install.sh --adapter mcp` |
| OpenCode | TBD | Planned | Future adapter |

### Terminal visual capabilities

Native visuals do not add a provider dependency; they require the adapter's safe TTY context
and one of the supported terminal protocols. Herdr is attempted first when its documented
session or socket context is present. If no native route succeeds, the daemon retains its
macOS AppleScript banner fallback. Terminal support boundaries, tmux passthrough behavior, and
SSH/headless fallback are documented in
[Native terminal visual delivery](http-api.md#native-terminal-visual-delivery).

## Voice ask (echo-converse)

The one-shot voice ask needs a recorder and a local transcriber that the notification path
does not, resolved on `PATH` in the **calling host's** process (overrides:
`ECHO_CONVERSE_*_BIN`):

| Dependency | Why | Behavior when absent |
|---|---|---|
| `sox` (provides `rec`) | Records the reply and ends the turn on silence | The ask refuses before spawning anything, naming `brew install sox` |
| `yap` | Tier 1 transcription (Apple SpeechAnalyzer, on device, no model download) | Falls back to the Tier 2 rung unless a tier is pinned |
| `whisper-cli` + a ggml model (`ECHO_CONVERSE_WHISPER_MODEL`) | Tier 2 transcription, portable | Only the Tier 1 rung is available |

The voice-ask install paths (`--adapter mcp|pi|omp`) preflight `sox` and `rec` before
changing host state. `cli/echo doctor` runs the same check and reports the exact missing
binary plus `brew install sox`; set `ECHO_CONVERSE_SOX_BIN` or `ECHO_CONVERSE_REC_BIN`
when the binaries live outside `PATH`.

Transcription is local by design: no cloud rung, no API key, no egress. Why `sox` is Tier 1
rather than Tier 2, and the rest of the pipeline: [`converse.md`](converse.md).

## Decision matrix

| Goal | Install |
|---|---|
| Minimum local server | Bun + `bash scripts/install.sh --adapter none` |
| Existing Claude Code workflow | Bun + Claude Code + `bash scripts/install.sh --adapter claudecode` |
| Pi voice lifecycle | Bun + Pi + `bash scripts/install.sh --adapter pi` |
| oh-my-pi voice lifecycle | Bun + omp + `bash scripts/install.sh --adapter omp` |
| Spoken questions with spoken answers | Bun + `sox` + `yap` (or `whisper-cli`) + `--adapter mcp` for Claude Code |
| Fully local speech | Bun + edge-tts or Kokoro + macOS fallback |
| Cloud premium voice | Bun + ElevenLabs key + ElevenLabs enabled in config |

See `README.md` for architecture and `docs/install-agent.md` for command-by-command verification.

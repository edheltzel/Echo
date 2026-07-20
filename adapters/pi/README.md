# Pi Adapter

Pi host adapter for Echo. Serves both upstream Pi and the oh-my-pi (omp) fork — see
[docs/adapters.md](../../docs/adapters.md) for the dual-host details (#18).

The adapter is a Pi package. It listens to Pi lifecycle events and translates them into `/notify` requests against the local voice server.

## Install locally

```bash
pi install ./adapters/pi
```

Or let the repository installer do it:

```bash
bash scripts/install.sh --adapter pi
```

For oh-my-pi, the installer reconciles a symlink registration instead (omp has no
`pi install`):

```bash
bash scripts/install.sh --adapter omp   # runs adapters/pi/reconcile-omp.ts
```

## Behavior

- `session_start` → speaks a greeting once for user-visible session starts, picked at
  random from a small pool of neutral lines (mirroring the Claude Code adapter's
  `startupCatchphrases`). Setting `ECHO_VOICE_CATCHPHRASE` pins the greeting to that one line.
- `message_end` / `turn_end` → extracts the final `🗣️` line from assistant text and speaks it once.
- Headless run modes are suppressed: Pi spawns subagents as `pi --mode json -p`, which report `ctx.hasUI === false`. Voice fires only when a real UI is present (`tui`/`rpc`). Set `ECHO_VOICE_SUPPRESS=true` to force-mute any context.

## Configuration

Environment variables (the legacy `ATLAS_VOICE_*` names still work as deprecated
silent fallbacks — see
[`docs/configuration.md`](../../docs/configuration.md#deprecated-environment-variables)):

Pi and omp load these values from the real process environment and Echo's standard
environment-file chain. For durable local settings, use `~/.config/echo/.env`; process
variables take precedence. Relaunch the host after editing the file:

```dotenv
ECHO_VOICE_PERSONA_NAME=Atlas
ECHO_VOICE_CATCHPHRASE="Atlas online and standing by."
```

| Variable | Default | Purpose |
|---|---|---|
| `ECHO_NOTIFY_URL` | `http://localhost:8888/notify` | Core notify endpoint |
| `ECHO_VOICE_TITLE` | `Pi Notification` | Notification title |
| `ECHO_VOICE_CATCHPHRASE` | random from built-in pool | Session-start greeting; setting it pins one line |
| `ECHO_VOICE_ID` | `pi` | Voice mapping/id (resolves to `agents.pi` in `core/voices.json`) |
| `ECHO_VOICE_ENABLED` | `true` | Set `false` for silent notifications |
| `ECHO_VOICE_GREET_ON_START` | `true` | Enable/disable greetings |
| `ECHO_VOICE_SPEAK_COMPLETIONS` | `true` | Enable/disable `🗣️` completion speech |
| `ECHO_VOICE_SUPPRESS_SUBAGENTS` | `true` | Suppress Pi subagent voices |
| `ECHO_VOICE_SUPPRESS` | `false` | Global emergency suppression |
| `ECHO_VOICE_PERSONA_NAME` | `Pi` | Spoken persona name in `🗣️` completions |

## Per-project persona & voice

A repo can override the persona **name + voice** (and greeting) for that project
only, using the **same convention as the Claude Code adapter**: a `daidentity` block
in the host's native `settings.json`. Pi layers config exactly like Claude Code —
`<project>/.pi/settings.json` (project) over `~/.pi/agent/settings.json` (global),
project wins per key — so Echo reads the `daidentity` block from both and merges
project-over-global:

```json
// <project>/.pi/settings.json
{
  "daidentity": {
    "name": "Echo",
    "voices": { "main": { "voiceId": "en-US-AndrewNeural" } },
    "startupCatchphrases": ["Echo online."]
  }
}
```

Resolved at `session_start` from `ctx.cwd`, per key: project `.pi/settings.json` →
global `~/.pi/agent/settings.json` → the env-based config above. `voiceId` is a real
edge-tts voice name (`bun scripts/preview-voices.ts --list`) — the daemon speaks it
literally, no `core/voices.json` edit needed. Takes effect on the next Pi session
started in that repo; every other repo keeps the global persona.

> omp shares this adapter today but reads `.omp/`, not `.pi/`, so an omp session sees
> no override yet — omp's native-config reader lands with the dedicated `adapters/omp`
> split ([#109](https://github.com/edheltzel/Echo/issues/109)).

## Status command

Inside Pi:

```text
/voice-status
```

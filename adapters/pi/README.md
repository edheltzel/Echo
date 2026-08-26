# Pi Adapter

Pi host adapter for Echo. The oh-my-pi (omp) fork has its own sibling package,
[`adapters/omp/`](../omp/README.md) - see [docs/adapters.md](../../docs/adapters.md) for what
the two share and how (#18, #109).

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
bash scripts/install.sh --adapter omp   # runs adapters/omp/reconcile.ts (dedicated omp adapter)
```

## Behavior

- `session_start` → speaks a greeting once for user-visible session starts.
  [The persona and voice guide](../../docs/voices.md#per-project-persona--voice) owns
  pool, `sayName`, and custom-line semantics. `ECHO_VOICE_CATCHPHRASE` pins one line.
- `message_end` / `turn_end` → extracts the final `🗣️` line from assistant text and speaks it once.
- Registers the `echo_ask` tool (speak a question, return the spoken reply as text) when the
  runtime exposes a tool API; a runtime without one keeps its voice notifications. Contract:
  [docs/converse.md](../../docs/converse.md).
- Headless run modes are suppressed: Pi spawns subagents as `pi --mode json -p`, which report `ctx.hasUI === false`. Voice fires only when a real UI is present (`tui`/`rpc`). Set `ECHO_VOICE_SUPPRESS` to `true` in `~/.config/echo/config.json` to force-mute any context.

## Configuration

Config properties (legacy `ATLAS_VOICE_*` process values remain one-release warning
fallbacks; see
[`docs/configuration.md`](../../docs/configuration.md#deprecated-environment-configuration)):

Pi and omp resolve these values exactly as the daemon does: `~/.config/echo/config.json`
wins over the one-release process and legacy dotenv fallbacks. Relaunch the host after
editing the file:

```json
{
  "ECHO_VOICE_PERSONA_NAME": "Atlas",
  "ECHO_VOICE_CATCHPHRASE": "Atlas online and standing by."
}
```

| Variable | Default | Purpose |
|---|---|---|
| `ECHO_NOTIFY_URL` | `http://localhost:3246/notify` | Core notify endpoint |
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
in the host's native `settings.json`. Pi layers config exactly like Claude Code -
`<project>/.pi/settings.json` (project) over `~/.pi/agent/settings.json` (global),
project wins per key - so Echo reads the `daidentity` block from both and merges
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
edge-tts voice name (`bun scripts/preview-voices.ts --list`) - the daemon speaks it
literally, no `core/voices.json` edit needed. Takes effect on the next Pi session
started in that repo; every other repo keeps the global persona.

> omp reads the same block from its own `.omp/config.yml` instead - see
> [`adapters/omp/README.md`](../omp/README.md).

### Scaffold it without hand-editing JSON

Inside Pi, run:

```text
/echo-voice [name] [voice]
```

The cross-host analog of the Claude Code `/echo-voice` command. Both arguments are
optional - anything missing is prompted for. It validates that the voice is a real
edge-tts name, then **deep-merges** the `daidentity` block into `<project>/.pi/settings.json`,
preserving every other setting. A present-but-unparseable `settings.json` **aborts** rather
than clobbering it. The command ships with the adapter (no installer step, unlike Claude
Code's symlinked markdown command). Takes effect on the next Pi session in that repo.

### Mute from the host

```text
/echo-mute [on|off|toggle|status|duration]
```

Runs `cli/echo mute`. Empty args toggle. Same machine-wide mute as the CLI.

## Status command

Inside Pi:

```text
/voice-status
```

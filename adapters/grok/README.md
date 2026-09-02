# Echo adapter for Grok Build

This adapter uses Grok Build's native lifecycle hooks. It registers one Echo-owned
file at `~/.grok/hooks/echo-voice.json` (always trusted; no per-repo `/hooks-trust`
required) that points `SessionStart` and `Stop` at `hook.ts`.

```bash
bash scripts/install.sh --adapter grok
```

## Behavior

- **Stop** (`reason == "end_turn"`): speaks an explicit final `🗣️ Name: summary` line
  when present, otherwise a short fallback summary of `lastAssistantMessage`.
- **Session-end Stop** (`reason` is `shutdown` / `channel_closed`): silent.
- **SubagentStop**: silent, so a fan-out does not produce a storm of spoken lines.
- **SessionStart** greetings: opt-in via `ECHO_VOICE_GREET_ON_START=true`; only
  new sessions (`source` of `new` / `startup` / `create`).

## Per-project persona and voice

Same `daidentity` shape as Claude Code / Pi / Codex. Drop into
`<project>/.grok/settings.json`:

```json
{
  "daidentity": {
    "name": "Themis",
    "voices": { "main": { "voiceId": "en-GB-LibbyNeural" } }
  }
}
```

Project wins over `~/.grok/settings.json`, then env defaults
(`ECHO_VOICE_PERSONA_NAME`, `ECHO_VOICE_ID`, ...).

## Ownership

Reconcile owns `echo-voice.json` under hooks and the `echo-mute` skill directory.
Sibling hooks such as firstmate's `fm-turn-end.json` / `fm-turn-end.sh` are never
rewritten or pruned. A foreign file already named `echo-voice.json` or a foreign
`echo-mute` skill is a fatal ownership conflict (exit 2).

## Environment overrides (tests)

| Variable | Purpose |
| --- | --- |
| `GROK_HOME` | Grok config directory (default `~/.grok`) |
| `ECHO_GROK_HOOKS_DIR` | Direct hooks directory override (wins over `GROK_HOME`) |
| `ECHO_GROK_SKILLS_DIR` | Direct skills directory override for `/echo-mute` |
| `HOME` | Affects the default `~/.grok` resolution via `os.homedir()` |

Never point tests at the operator's real `~/.grok`.

## Mute from the host

Grok's lifecycle hook still runs under `bun` and is **not** the mute path. Mute is a
user-invocable skill at `~/.grok/skills/echo-mute` that runs `bash cli/echo mute`.

```text
/echo-mute [on|off|toggle|status|duration]
```

Empty args toggle. Same machine-wide mute as the CLI. Slash appearance depends on Grok
surfacing user-invocable skills; this registration is shipped, not claimed live-proved here.

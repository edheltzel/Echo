# Echo adapter for OpenCode

This adapter is an OpenCode plugin. It registers one Echo-owned symlink,
`echo-voice.ts`, in `~/.config/opencode/plugins/` pointing at `plugin.ts`.
OpenCode auto-loads that directory. Host config files are not rewritten.

```bash
bash scripts/install.sh --adapter opencode
```

## Behavior

OpenCode's documented plugin surface (`opencode.ai/docs/plugins`):

- **`session.idle`**: speaks an explicit final `🗣️ Name: summary` line when
  present, otherwise a short fallback summary of the last assistant message.
- **`session.created`**: greeting is opt-in via `ECHO_VOICE_GREET_ON_START`.
- **Subagent sessions** (`parentID` set): silent.
- **Unknown `parentID`**: fail closed (silent) when `session.get` cannot resolve
  the session.

## Per-project persona and voice

Same `daidentity` shape as Claude Code / Pi / Codex. Drop into the project's
`opencode.jsonc` or `opencode.json` (OpenCode's real config files, not `.opencode/config.json`):

```json
{
  "daidentity": {
    "voices": { "main": { "voiceId": "en-IN-NeerjaExpressiveNeural" } },
    "sayName": false,
    "startupCatchphrases": ["There is no spoon."]
  }
}
```

Project wins over the first existing global file (`opencode.jsonc`, then
`opencode.json`, then `config.json`), then env defaults
(`ECHO_VOICE_PERSONA_NAME`, `ECHO_VOICE_ID`, ...). `sayName` defaults false.

## Ownership

Reconcile owns **only** `~/.config/opencode/plugins/echo-voice.ts`. Sibling
plugins are never rewritten or pruned. A dead Echo spelling is healed. A
dangling or live non-Echo occupant of that name is refused (exit 2).

## Environment overrides (tests)

| Variable | Purpose |
| --- | --- |
| `ECHO_OPENCODE_PLUGINS_DIR` | Exact plugins directory for registration |
| `ECHO_OPENCODE_CONFIG` | Exact OpenCode config path for persona reads |
| `XDG_CONFIG_HOME` | Used when those pins are unset (`$XDG_CONFIG_HOME/opencode/plugins` and the first existing config file there) |

Never point tests at the operator's real `~/.config/opencode`.

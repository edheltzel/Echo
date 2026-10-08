# Echo adapter for OpenCode

An OpenCode plugin plus the `/echo-mute` command. Registration owns two symlinks and
rewrites no OpenCode config file:

- `~/.config/opencode/plugins/echo-voice.ts` → `plugin.ts` (OpenCode auto-loads this directory)
- `~/.config/opencode/commands/echo-mute.md` → `commands/echo-mute.md` (bash `cli/echo mute`)

```bash
bash scripts/install.sh --adapter opencode
```

Load the plugin once. Do not also list `adapters/opencode/plugin.ts` under `"plugin"` in
`opencode.json`: OpenCode would load two instances and every line would be spoken twice.

## Behavior

Plugin events (`opencode.ai/docs/plugins`, `@opencode-ai/sdk` v1 types):

- **`session.idle`**: speaks the final `🗣️ Name: summary` line when present, otherwise a
  short fallback summary of the last assistant message. Deduped per session + message.
- **`session.created`**: greeting is opt-in via `ECHO_VOICE_GREET_ON_START`.
- **Subagent sessions** (`parentID` set): silent.
- **Unreadable session** (`session.get` returns an error): silent (fail closed).

The plugin `client` is the v1 SDK: calls take `{ path: { id } }` and return
`{ data, error }` without throwing.

## Persona and voice

Default persona `OpenCode`, voice key `opencode` in `core/voices.json`. Override per project
with a `daidentity` block in OpenCode's own config, `opencode.jsonc` or `opencode.json`
(JSONC is accepted):

```json
{
  "daidentity": {
    "name": "Neo",
    "voices": { "main": { "voiceId": "en-IN-NeerjaExpressiveNeural" } },
    "sayName": false,
    "startupCatchphrases": ["There is no spoon."]
  }
}
```

Project wins per key over the first existing global file (`opencode.jsonc`, then
`opencode.json`, then `config.json`), which wins over env and adapter defaults
(`ECHO_VOICE_PERSONA_NAME`, `ECHO_VOICE_ID`, `ECHO_VOICE_SAY_NAME`).

## Ownership

Reconcile heals a dead Echo-spelled link (a moved checkout) and refuses any other occupant
of either name (exit 2). `--check`: 0 current, 3 pending, 2 fatal.

## Environment overrides (tests)

| Variable | Purpose |
| --- | --- |
| `ECHO_OPENCODE_PLUGINS_DIR` | Exact plugins directory |
| `ECHO_OPENCODE_COMMANDS_DIR` | Exact commands directory |
| `ECHO_OPENCODE_CONFIG` | Exact global OpenCode config path for persona reads |
| `XDG_CONFIG_HOME` | Base for all three when unset |

Never point tests at the operator's real `~/.config/opencode`.

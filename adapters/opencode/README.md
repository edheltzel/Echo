# Echo adapter for OpenCode

An OpenCode plugin plus the `/echo-mute` and `/echo-mode` commands. Registration owns three symlinks:

- `~/.config/opencode/plugins/echo-voice.ts` → `plugin.ts` (OpenCode auto-loads this directory)
- `~/.config/opencode/commands/echo-mute.md` → `commands/echo-mute.md` (bash `cli/echo mute`)
- `~/.config/opencode/commands/echo-mode.md` → `commands/echo-mode.md` (bash `cli/echo mode`)

```bash
bash scripts/install.sh --adapter opencode
```

OpenCode also loads every `"plugin"` entry in its global config, so an entry pointing at any
clone's `adapters/opencode/plugin.ts` (string or `[spec, options]` form) would load Echo twice
and speak every line twice. OpenCode merges `config.json` < `opencode.json` < `opencode.jsonc`
and a later `plugin` array replaces an earlier one, so reconcile prunes the highest-priority
global file that has a `plugin` key; an entry it shadows never loads and is left alone.
Pruning writes a backup next to the real file and follows symlinks. It will not rewrite a
JSONC file with comments; it exits 2 and names the entry to remove by hand. An empty or
unparseable config file is reported and skipped, never a reason to block the install.

## Behavior

Plugin events (`opencode.ai/docs/plugins`, `@opencode-ai/sdk` v1 types):

- **`session.idle`**: speaks the final `🗣️ Name: summary` line of the newest assistant
  message when present, otherwise a short fallback summary of it. A newest message with no
  text (a `!shell` turn, an abort during a tool call) stays silent. Deduped per session +
  message id, including two idles for one turn arriving at once (OpenCode publishes
  `session.idle` twice on an aborted or errored turn and does not await plugin hooks).
- **`session.created`**: greeting is opt-in via `ECHO_VOICE_GREET_ON_START`.
- **Subagent sessions** (`parentID` set): silent.
- **Unreadable session** (`session.get` returns an error): silent (fail closed).
- **Every other event** (streamed parts, message updates) returns before any config read or
  server call.

The plugin `client` is the v1 SDK: calls take `{ path: { id } }` and return
`{ data, error }` without throwing.

## Persona and voice

Default persona `OpenCode`, voice key `opencode` in `core/voices.json`. Override it with a
`daidentity` block in any config file OpenCode reads (JSONC is accepted):

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

Echo merges `daidentity` across the same files, in the same order, that OpenCode merges its
own config (objects per key, later files win): the three global files, `OPENCODE_CONFIG`,
`opencode.json(c)` from the worktree root down to the session's folder, every `.opencode/`
folder from that folder up plus `~/.opencode/`, then `OPENCODE_CONFIG_DIR`.
`OPENCODE_DISABLE_PROJECT_CONFIG` drops the project and project `.opencode/` layers. The
result wins over env and adapter defaults (`ECHO_VOICE_PERSONA_NAME`, `ECHO_VOICE_ID`,
`ECHO_VOICE_SAY_NAME`).

## Ownership

Reconcile heals a dead Echo-spelled link (a moved checkout) and refuses any other occupant
of any of those names (exit 2). `--check`: 0 current, 3 pending, 2 fatal.

## Environment overrides (tests)

| Variable | Purpose |
| --- | --- |
| `ECHO_OPENCODE_PLUGINS_DIR` | Exact plugins directory |
| `ECHO_OPENCODE_COMMANDS_DIR` | Exact commands directory |
| `ECHO_OPENCODE_CONFIG` | Exact single global OpenCode config file (replaces the three-file discovery) |
| `XDG_CONFIG_HOME` | Base for all three when unset |

Never point tests at the operator's real `~/.config/opencode`.

# Claude Code Adapter

Claude Code integration for Echo.

This adapter owns all Claude Code integration glue:

- `hooks/VoiceGreeting.hook.ts` - session-start greeting
- `hooks/VoiceGate.hook.ts` - subagent voice curl suppression
- `hooks/handlers/VoiceNotification.ts` - stop-phase `🗣️` completion speech
- `restore-hooks.ts` - idempotent registration into Claude Code settings
- `commands/echo-voice.md` / `commands/echo-mute.md` - slash commands, symlinked into
  `~/.claude/commands/` by the installer (`/echo-mute` runs `cli/echo mute`)

The universal server core must not import this adapter. The adapter sends HTTP requests to the core `/notify` endpoint.

## Subagent voice policy

`VoiceGate` suppresses subagent voice curls by default, preserving the anti-flood
behavior for existing installations and for a missing configuration. To opt in,
run `cli/echo voice <name> <edge-tts-voice-id>` interactively and answer **yes** to
“Enable voice for subagents?”, or use `--allow-subagents` in automation. The setting
is stored in `ECHO_VOICE_SUPPRESS_SUBAGENTS`: `true` means silent (default), while
`false` allows subagent curls through the gate. Main-session voice is unaffected.

## Re-apply registrations

```bash
bun run adapters/claudecode/restore-hooks.ts
bun run adapters/claudecode/reconcile-commands.ts
```

The first command backs up settings before mutating them. The second reconciles only Echo's
`echo-voice.md` and `echo-mute.md` symlinks. Both are safe to run repeatedly.

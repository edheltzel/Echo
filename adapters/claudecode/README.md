# Claude Code Adapter

Claude Code integration for Echo.

This adapter owns all Claude Code lifecycle glue:

- `hooks/VoiceGreeting.hook.ts` — session-start greeting
- `hooks/VoiceGate.hook.ts` — subagent voice curl suppression
- `hooks/handlers/VoiceNotification.ts` — stop-phase `🗣️` completion speech
- `restore-hooks.ts` — idempotent registration into Claude Code settings

The universal server core must not import this adapter. The adapter sends HTTP requests to the core `/notify` endpoint.

## Re-apply hooks

```bash
bun run adapters/claudecode/restore-hooks.ts
```

The script backs up settings before mutating them and is safe to run repeatedly.

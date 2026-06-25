# PAI Adapter

PAI-specific integration for atlas-voicesystem.

This adapter owns all Claude/PAI lifecycle glue:

- `hooks/VoiceGreeting.hook.ts` — session-start greeting
- `hooks/VoiceGate.hook.ts` — subagent voice curl suppression
- `hooks/handlers/VoiceNotification.ts` — stop-phase `🗣️` completion speech
- `restore-hooks.ts` — idempotent registration into PAI/Claude settings

The universal server core must not import this adapter. The adapter sends HTTP requests to the core `/notify` endpoint.

## Re-apply hooks

```bash
bun run adapters/pai/restore-hooks.ts
```

The script backs up settings before mutating them and is safe to run repeatedly.

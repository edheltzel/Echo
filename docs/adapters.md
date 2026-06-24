# Adapters & PAI compatibility path

Adapters are out-of-process host integrations that translate host lifecycle events into
`POST /notify` calls. They import nothing from `core/` and speak only the HTTP contract. See
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the boundary and [`http-api.md`](http-api.md)
for the wire shape.

## Adapter rules

Adapters should:

1. Observe host lifecycle events.
2. Extract a short user-facing message (for Pi/PAI, the final `🗣️` line).
3. Add `source` and `session_id` metadata when available.
4. POST to `http://localhost:8888/notify`.
5. Treat notify failures as non-fatal host-session warnings.
6. Suppress child/subagent contexts to avoid audio floods.

## Pi adapter — per-turn completions (issue #15)

Pi's own models don't emit the PAI `🗣️` line on their own, so the Pi adapter **injects** the
convention. On `before_agent_start` (`adapters/pi/index.ts`) it appends an instruction to the
chained `event.systemPrompt` (feature-detected; falls back to `systemPromptAppend`; no-ops on
older runtimes) telling the model to end each response with `🗣️ <Name>: <8–16 word
summary>`. The existing `message_end`/`turn_end` path then extracts and speaks that line — so
Pi speaks per-turn completions like the Claude Code path, not just the startup greeting.

- **Persona name** comes from config: `personaName` ← env `ATLAS_VOICE_PERSONA_NAME` (default
  `"Atlas"`), never hard-coded.
- Injection is gated on `config.speakCompletions` (default on) **and** the same
  `shouldSuppressVoice` check the speak side uses (headless/subagent stays silent).
- `extractVoiceLineFromText` (`adapters/pi/voice-line.ts`) strips an optional leading
  `<Name>:` (mirroring PAI's `parseFinalVoiceLine` name grammar) so the persona name isn't
  spoken aloud.
- Adapter-only: no `core/` or daemon change; the daemon already resolves `voice_id` name
  keys.

The full design rationale is catalogued in
[`design-docs/pi-completion-injection.md`](design-docs/pi-completion-injection.md).

## PAI compatibility path

The old deep files under `claudecode/.claude/PAI/USER/Voice/` are compatibility wrappers:

- `server.ts` imports `core/server.ts` while preserving legacy PAI config/env paths.
- Hook entrypoints import/re-export `adapters/pai/hooks/...`.
- Lifecycle shell scripts delegate to root `scripts/` and old install defaults to
  `--adapter pai`.

PAI wrapper smoke checks:

```bash
printf '{"tool_name":"Bash","tool_input":{"command":"echo ok"}}' \
  | bun run claudecode/.claude/PAI/USER/Voice/hooks/VoiceGate.hook.ts

printf '{"source":"resume"}' \
  | bun run claudecode/.claude/PAI/USER/Voice/hooks/VoiceGreeting.hook.ts
```

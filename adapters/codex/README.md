# Echo adapter for Codex

This adapter uses Codex lifecycle hooks. It registers Echo-owned `SessionStart`
and `Stop` command hooks into the Codex hooks document:

- project: `<cwd>/.codex/hooks.json` when present
- else: `~/.codex/hooks.json`

```bash
bash scripts/install.sh --adapter codex
```

## Behavior

- **Normal Stop**: speaks an explicit final `Name: summary` voice line when present,
  otherwise a short fallback summary of the last assistant message. Codex live-turn suppression
  is documented in [`docs/adapters.md`](../../docs/adapters.md#live-session-voice-suppression---omp-and-codex).
- **SessionStart** greetings: opt-in via `ECHO_VOICE_GREET_ON_START=true`.
- Subagent-related stop events stay silent.

## Per-project persona and voice

Same `daidentity` shape as Claude Code / Pi / Grok. Drop into
`<project>/.codex/settings.json`:

```json
{
  "daidentity": {
    "name": "Themis",
    "voices": { "main": { "voiceId": "en-GB-LibbyNeural" } }
  }
}
```

Project wins over `~/.codex/settings.json`, then env defaults
(`ECHO_VOICE_PERSONA_NAME`, `ECHO_VOICE_ID`, ...).

## Ownership

Reconcile only adds/updates the Echo `adapters/codex/hook.ts` command entries.
Other hooks (Firstmate turn-end guards, arm checks, foreign tools) are preserved.

## Environment overrides (tests)

| Variable | Purpose |
| --- | --- |
| `ECHO_CODEX_HOOKS_FILE` | Direct hooks.json path override |
| `CODEX_HOME` | Codex home (default `~/.codex`) when no project hooks file exists |

Never point tests at the operator's real `~/.codex/hooks.json` without a scratch file.

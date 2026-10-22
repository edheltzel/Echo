# Echo adapter for Empryo

Empryo runs Claude Code-format lifecycle hooks. This adapter registers one executable,
`hook.ts`, for `SessionStart`, `Stop`, and `Notification` in `~/.empryo/hooks.json`
(`ECHO_EMPRYO_HOOKS_FILE` overrides the path).

```bash
cli/echo install --adapter empryo
```

Notifications report `source: "empryo"`.

The installer also links `skills/echo-mute` and `skills/echo-mode` into `~/.empryo/skills`
(`ECHO_EMPRYO_SKILLS_DIR` overrides). Empryo's terminal UI has no user-defined slash commands, so
you run them by naming the skill: `$echo-mute on`, `$echo-mute off`, `$echo-mute status`,
`$echo-mode sounds`. The agent loads the skill and runs `cli/echo mute` or `cli/echo mode`.
`/echo-mute` reports "Unknown command" there.

- **Greeting.** A desktop or terminal session says "Empryo, ready." Headless, resume, and
  reload starts stay silent. `ECHO_VOICE_GREET_ON_START=false` disables it.
- **Completion.** Empryo's `Stop` payload carries no response text, so the hook reads the
  session event log at `transcript_path` and speaks the turn's final `🗣️ Name: summary`
  line, or a short fallback summary. Headless runs stay silent, like print mode on the other
  hosts.
- **Needs input.** `permission_prompt` and `plan_review` announce an approval,
  `elicitation_dialog` speaks the question. Each request speaks once.
- **Child tabs.** Tabs the agent opened for itself stay silent unless
  `ECHO_VOICE_SUPPRESS_CHILD_TABS=false`. Tabs you open speak.
- **Automation.** Empryo hands hooks a safe subset of its environment. Start Empryo with
  `EMPRYO_HOOK_ENV="NO_MISTAKES_GATE"` so the automation policy can see the marker.

Empryo also loads `~/.claude/settings.json` and Codex hook files. The Claude Code and Codex
Echo hooks detect `EMPRYO_PROJECT_DIR`, which Empryo sets for every hook it runs, and stand
down so nothing speaks twice.

Persona: `daidentity` from `<project>/.empryo/settings.json` over `~/.empryo/settings.json`,
the same shape as the other hosts:

```json
{
  "daidentity": {
    "voices": { "main": { "voiceId": "en-US-AvaMultilingualNeural" } }
  }
}
```

See [voice precedence and the global fallback](../../docs/voices.md#which-voice-a-harness-speaks).

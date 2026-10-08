# Claude Code Adapter

Claude Code integration for Echo.

This adapter owns all Claude Code integration glue:

- `hooks/VoiceGreeting.hook.ts` - session-start greeting
- `hooks/VoiceGate.hook.ts` - subagent voice curl suppression
- `hooks/VoiceHil.hook.ts` - needs-input / approval / attention (`PermissionRequest`, `Notification`)
- `hooks/handlers/VoiceNotification.ts` - stop-phase `🗣️` completion speech
- `hooks/handlers/VoiceHil.ts` - HIL notify path (transcript `AskUserQuestion` / `awaitingInput`)
- `restore-hooks.ts` - idempotent registration into Claude Code settings
- `commands/echo-voice.md` / `commands/echo-mute.md` - slash commands, symlinked into
  `~/.claude/commands/` by the installer (`/echo-mute` runs `cli/echo mute`)
- `plugin/` - mute-only Claude Code plugin. Claude namespaces plugin skills, so the
  plugin form is `/echo:echo-mute`. Bare `/echo-mute` stays the installer command.
  Neither registers Stop/SessionStart/VoiceGate hooks or installs the daemon.

The universal server core must not import this adapter. The adapter sends HTTP requests to the core `/notify` endpoint.

## Mute plugin

Lifecycle hooks stay on `restore-hooks.ts`. Claude plugin skills are always namespaced
(`/plugin-name:skill-name`), so this plugin's skill is `/echo:echo-mute`. Bare
`/echo-mute` remains the installer slash command in `~/.claude/commands/` after
`cli/echo install --adapter claudecode`. Type either; both run `cli/echo mute`.
The plugin skill resolves `cli/echo` from PATH or the current Echo checkout and does
not walk `~/.claude/commands` (that symlink may point at a stale worktree).

```bash
claude plugin validate adapters/claudecode/plugin --strict
claude --plugin-dir adapters/claudecode/plugin
```

If `claude` is not installed, `bun test tests/adapters/claudecode/plugin.test.ts` is the
in-repo equivalent: it checks the manifest, layout, both invocation names, and that the
mute skill invokes `cli/echo mute`.

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

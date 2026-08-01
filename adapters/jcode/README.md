# Echo adapter for Jcode

This adapter uses Jcode's native lifecycle hooks. It registers one executable for
`session_start` and `turn_end` in `~/.jcode/config.toml` (or `$JCODE_HOME/config.toml`).

```bash
bash scripts/install.sh --adapter jcode
```

Jcode's `turn_end` hook covers TUI, desktop, headless, and swarm sessions. Echo speaks only
an explicit final `🗣️ Name: summary` line from Jcode's bounded response tail, and suppresses
events whose lifecycle metadata identifies a child session. Startup greetings are disabled
by default; when enabled with `ECHO_VOICE_GREET_ON_START=true`, only newly created root
sessions greet (attach/resume and child sessions stay silent).

Jcode currently supports one command per hook. Installation refuses to replace a non-Echo
`session_start` or `turn_end` command. Hook commands are shell-quoted for checkout paths with
spaces. Unsupported TOML shapes fail closed rather than risking config corruption; convert an
inline or array-form `hooks` value to the documented `[hooks]` table before retrying.

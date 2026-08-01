# Echo adapter for Jcode

This adapter uses Jcode's native lifecycle hooks. It registers one executable for
`session_start` and `turn_end` in `~/.jcode/config.toml` (or `$JCODE_HOME/config.toml`).

```bash
bash scripts/install.sh --adapter jcode
```

Jcode's `turn_end` hook covers TUI, desktop, headless, and swarm sessions. Echo therefore
speaks only an explicit final `🗣️ Name: summary` line and keeps startup greetings disabled
by default, avoiding audio floods from background workers. Set
`ECHO_VOICE_GREET_ON_START=true` to opt into greetings.

Jcode currently supports one command per hook. Installation refuses to replace a non-Echo
`session_start` or `turn_end` command. Remove or combine that hook manually before retrying.

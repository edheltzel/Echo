# Echo adapter for OpenCode

Mute-only registration. This package does **not** speak OpenCode lifecycle events
and does not add OpenCode-named routes to the daemon. It installs `/echo-mute` as
an OpenCode custom command that runs `cli/echo mute`.

```bash
bash scripts/install.sh --adapter opencode
```

OpenCode discovers markdown commands from `~/.config/opencode/commands/`. Reconcile
owns exactly one symlink: `echo-mute.md` → `adapters/opencode/commands/echo-mute.md`.
Sibling command files are never rewritten or pruned.

## Mute from the host

```text
/echo-mute [on|off|toggle|status|duration]
```

Runs `bash cli/echo mute`. Empty args toggle. Same machine-wide mute as the CLI.
Do not POST `/mute` from OpenCode and do not invent a second mute path.

This host's slash surface is registered in unit tests; it is not claimed live-proved
here if OpenCode did not start in the environment that shipped the change.

## Environment overrides (tests)

| Variable | Purpose |
| --- | --- |
| `ECHO_OPENCODE_COMMANDS_DIR` | Direct commands directory override |
| `XDG_CONFIG_HOME` | Used when the override is unset (`$XDG_CONFIG_HOME/opencode/commands`) |
| `HOME` | Default `~/.config/opencode/commands` via `os.homedir()` |

Never point tests at the operator's real `~/.config/opencode`.

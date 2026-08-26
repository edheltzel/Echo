---
description: Mute or unmute Echo audio (on/off/toggle/status or a duration like 30m).
argument-hint: [on|off|toggle|status|duration]
allowed-tools: Bash
---

Mute Echo through the existing CLI. Do not POST `/mute` yourself and do not invent a second mute path.

Arguments: `$ARGUMENTS` (`on`, `off`, `toggle`, `status`, or a duration such as `30m` / `1h`). Empty means `status`.

Resolve `cli/echo` from the installer symlink, then run it:

```bash
CMD="${HOME}/.claude/commands/echo-mute.md"
CLI="$(cd "$(dirname "$(realpath "$CMD")")/../../.." && pwd)/cli/echo"
ARGS="${ARGUMENTS:-status}"
bash "$CLI" mute $ARGS
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show the JSON the CLI printed. Mute is machine-wide: it silences every Echo speaker on this Mac. It does not silence audio Echo did not produce (for example Oh My Pi `/live`).

---
description: Mute Echo audio for every session on this machine (on/off/toggle/status/duration).
---

Mute Echo through the existing CLI. Do not POST `/mute` yourself, do not use Bun, and do not invent a second mute path.

Arguments: `$ARGUMENTS` (`on`, `off`, `toggle`, `status`, or a duration such as `30m` / `1h`). Empty means `toggle`.

Resolve `cli/echo` from the installer symlink, then run it:

```bash
CMD="${HOME}/.config/opencode/commands/echo-mute.md"
CLI="$(cd "$(dirname "$(realpath "$CMD")")/../../.." && pwd)/cli/echo"
ARGS="$ARGUMENTS"
[ -n "$ARGS" ] || ARGS=toggle
bash "$CLI" mute "$ARGS"
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show the JSON the CLI printed. Mute is machine-wide: it silences every Echo speaker on this Mac. It does not silence audio Echo did not produce (for example Oh My Pi `/live`).

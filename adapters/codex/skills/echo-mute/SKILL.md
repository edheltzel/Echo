---
name: echo-mute
description: Mute Echo audio for every session on this machine (on/off/toggle/status/duration). Use when the user types /echo-mute or asks to mute Echo.
---

Mute Echo through the existing CLI. Do not POST `/mute` yourself, do not use Bun, and do not invent a second mute path. Codex lifecycle hooks are not the mute path.

Arguments after the command (`on`, `off`, `toggle`, `status`, or a duration such as `30m` / `1h`). Empty means `toggle`.

Resolve `cli/echo` from this skill's location, then run it:

```bash
SKILL="${HOME}/.codex/skills/echo-mute/SKILL.md"
CLI="$(cd "$(dirname "$(realpath "$SKILL")")/../../../.." && pwd)/cli/echo"
ARGS="${1:-}"
[ -n "$ARGS" ] || ARGS=toggle
bash "$CLI" mute "$ARGS"
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show the JSON the CLI printed. Mute is machine-wide: it silences every Echo speaker on this Mac. It does not silence audio Echo did not produce (for example Oh My Pi `/live`).

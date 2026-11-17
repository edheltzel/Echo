---
name: echo-mute
description: Mute Echo audio for every session on this machine (on/off/toggle/status/duration). Use when the user types $echo-mute or asks to mute or unmute Echo.
---

Mute Echo through the existing CLI. Do not POST `/mute` yourself, do not use Bun, and do not invent a second mute path. The Empryo lifecycle hook is not the mute path.

Arguments: the text after `$echo-mute` (`on`, `off`, `toggle`, `status`, or a duration such as `30m` / `1h`, optionally followed by a scope `tts`, `mic`, or `all`). Nothing typed means `toggle`.

Resolve `cli/echo` from this skill's location, then run it with those arguments in place of `toggle`:

```bash
SKILL="${HOME}/.empryo/skills/echo-mute/SKILL.md"
CLI="$(cd "$(dirname "$(realpath "$SKILL")")/../../../.." && pwd)/cli/echo"
bash "$CLI" mute toggle
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show what the CLI printed. Mute is machine-wide: it silences every Echo speaker on this Mac. It does not silence audio Echo did not produce.

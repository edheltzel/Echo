---
name: echo-mode
description: Switch Echo between speech and sounds for every session on this machine (speech/sounds/status). Use when the user types $echo-mode or asks Echo to speak or play sounds instead.
---

Switch Echo's output mode through the existing CLI. Do not POST `/mode` yourself, do not use Bun, and do not invent a second mode path. The Empryo lifecycle hook is not the mode path.

Arguments: the text after `$echo-mode` (`speech`, `sounds`, or `status`). Nothing typed means `status`.

Resolve `cli/echo` from this skill's location, then run it with that argument in place of `status`:

```bash
SKILL="${HOME}/.empryo/skills/echo-mode/SKILL.md"
CLI="$(cd "$(dirname "$(realpath "$SKILL")")/../../../.." && pwd)/cli/echo"
bash "$CLI" mode status
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show what the CLI printed. Mode is machine-wide: it changes every Echo session on this Mac.

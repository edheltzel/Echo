---
name: echo-mode
description: Switch Echo between speech and sounds for every session on this machine (speech/sounds/status).
disable-model-invocation: true
---

Switch Echo's output mode through the existing CLI. Do not POST `/mode` yourself, do not use Bun, and do not invent a second mode path. The Jcode lifecycle hook is not the mode path.

Arguments: whatever the user typed after `/echo-mode` (`speech`, `sounds`, or `status`). Nothing typed means `status`.

Resolve `cli/echo` from this skill's location, then run it with that argument in place of `status`:

```bash
SKILL="${JCODE_HOME:-$HOME/.jcode}/skills/echo-mode/SKILL.md"
CLI="$(cd "$(dirname "$(realpath "$SKILL")")/../../../.." && pwd)/cli/echo"
bash "$CLI" mode status
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show what the CLI printed. Mode is machine-wide: it changes every Echo session on this Mac.

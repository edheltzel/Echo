---
name: echo-mode
description: Switch Echo between speech and sounds for every session on this machine (speech/sounds/status). Use when the user types /echo-mode or asks to change Echo's output mode.
---

Switch Echo's output mode through the existing CLI. Do not POST `/mode` yourself, do not use Bun, and do not invent a second mode path. Codex lifecycle hooks are not the mode path.

Arguments after the command (`speech`, `sounds`, or `status`). Empty prints usage.

Resolve `cli/echo` from this skill's location, then run it:

```bash
SKILL="${HOME}/.codex/skills/echo-mode/SKILL.md"
CLI="$(cd "$(dirname "$(realpath "$SKILL")")/../../../.." && pwd)/cli/echo"
ARGS="${1:-}"
bash "$CLI" mode $ARGS
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show what the CLI printed. Mode is machine-wide: it changes every Echo session on this Mac.

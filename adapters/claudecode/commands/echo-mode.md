---
description: Switch Echo between speech and sounds for every session on this machine (speech/sounds/status).
argument-hint: [speech|sounds|status]
allowed-tools: Bash
---

Switch Echo's output mode through the existing CLI. Do not POST `/mode` yourself and do not invent a second mode path.

Arguments: `$ARGUMENTS` (`speech`, `sounds`, or `status`). Empty prints usage.

Resolve `cli/echo` from the installer symlink, then run it:

```bash
CMD="${HOME}/.claude/commands/echo-mode.md"
CLI="$(cd "$(dirname "$(realpath "$CMD")")/../../.." && pwd)/cli/echo"
ARGS="$ARGUMENTS"
bash "$CLI" mode $ARGS
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show what the CLI printed. Mode is machine-wide: it changes every Echo session on this Mac.

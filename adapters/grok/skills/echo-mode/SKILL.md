---
name: echo-mode
description: Switch Echo between speech and sounds for every session on this machine (speech/sounds/status).
argument-hint: [speech|sounds|status]
user-invocable: true
disable-model-invocation: true
allowed-tools: Bash
---

Switch Echo's output mode through the existing CLI. Do not POST `/mode` yourself, do not use Bun, and do not invent a second mode path. The Grok lifecycle hook is not the mode path.

Arguments: `$ARGUMENTS` (`speech`, `sounds`, or `status`). Empty prints usage.

Resolve `cli/echo` from this skill's location, then run it:

```bash
SKILL="${HOME}/.grok/skills/echo-mode/SKILL.md"
CLI="$(cd "$(dirname "$(realpath "$SKILL")")/../../../.." && pwd)/cli/echo"
ARGS="$ARGUMENTS"
bash "$CLI" mode $ARGS
```

If that file is missing, try `cli/echo` at the current repo root (`git rev-parse --show-toplevel`).

Show what the CLI printed. Mode is machine-wide: it changes every Echo session on this Mac.

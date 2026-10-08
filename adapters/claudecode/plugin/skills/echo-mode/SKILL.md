---
name: echo-mode
description: Switch Echo between speech and sounds for every session on this machine (speech/sounds/status). Use when the user types /echo-mode or /echo:echo-mode.
argument-hint: [speech|sounds|status]
allowed-tools: Bash
---

Switch Echo's output mode through the existing CLI. Do not POST `/mode` yourself and do not invent a second mode path.

Arguments: `$ARGUMENTS` (`speech`, `sounds`, or `status`). Empty prints usage.

Resolve `cli/echo` from PATH or a known Echo checkout. Do not walk a host command symlink.

```bash
ARGS="$ARGUMENTS"

CLI=""

# PATH: a checkout root (…/cli/echo) or the cli/ directory (Echo CLI named echo).
# Skip the shell builtin and /bin/echo.
OLDIFS="$IFS"
IFS=:
for dir in ${PATH:-}; do
  [ -n "$dir" ] || continue
  if [ -f "$dir/cli/echo" ]; then
    CLI="$dir/cli/echo"
    break
  fi
  if [ -f "$dir/echo" ] && grep -q "Usage: echo <command>" "$dir/echo" 2>/dev/null; then
    CLI="$dir/echo"
    break
  fi
done
IFS="$OLDIFS"

# Known install location: Echo checkout of the current working tree.
if [ -z "$CLI" ]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$ROOT" ] && [ -f "$ROOT/cli/echo" ]; then
    CLI="$ROOT/cli/echo"
  fi
fi

# Known install location: plugin loaded from this checkout (not a copied cache).
# Walk up from the plugin root looking for cli/echo.
if [ -z "$CLI" ] && [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -d "${CLAUDE_PLUGIN_ROOT}" ]; then
  here="${CLAUDE_PLUGIN_ROOT}"
  while [ -n "$here" ] && [ "$here" != "/" ]; do
    if [ -f "$here/cli/echo" ]; then
      CLI="$here/cli/echo"
      break
    fi
    here="$(cd "$here/.." && pwd)"
  done
fi

if [ -z "$CLI" ] || [ ! -f "$CLI" ]; then
  echo "echo mode: cli/echo not found on PATH or in this checkout" >&2
  exit 1
fi

bash "$CLI" mode $ARGS
```

Show what the CLI printed. Mode is machine-wide: it changes every Echo session on this Mac.

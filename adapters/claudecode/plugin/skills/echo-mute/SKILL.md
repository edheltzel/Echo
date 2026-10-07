---
name: echo-mute
description: Mute Echo audio for every session on this machine (on/off/toggle/status/duration). Use when the user types /echo-mute or /echo:echo-mute.
argument-hint: [on|off|toggle|status|duration]
allowed-tools: Bash
---

Mute Echo through the existing CLI. Do not POST `/mute` yourself and do not invent a second mute path.

Arguments: `$ARGUMENTS` (`on`, `off`, `toggle`, `status`, or a duration such as `30m` / `1h`). Empty means `toggle`.

Resolve `cli/echo` from PATH or a known Echo checkout. Do not walk a host command symlink.

```bash
ARGS="$ARGUMENTS"
[ -n "$ARGS" ] || ARGS=toggle

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
  echo "echo mute: cli/echo not found on PATH or in this checkout" >&2
  exit 1
fi

bash "$CLI" mute "$ARGS"
```

Show the JSON the CLI printed. Mute is machine-wide: it silences every Echo speaker on this Mac. It does not silence audio Echo did not produce (for example Oh My Pi `/live`).

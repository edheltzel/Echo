#!/bin/bash
# echo status — one view of the daemon, its output, and every registered harness.
# Reads GET /health (loopback, not rate-limited) and the host registration files.
# Never changes anything. Degrades to "not running" when the daemon is down.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"

use_color() { [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; }

# dim, ok (green), warn (yellow), bad (red), label (bold). Plain when not a TTY.
paint() {
  local code="$1" text="$2"
  if use_color; then printf '\033[%sm%s\033[0m' "$code" "$text"; else printf '%s' "$text"; fi
}
dim()   { paint "2" "$1"; }
ok()    { paint "32" "$1"; }
warn()  { paint "33" "$1"; }
bad()   { paint "31" "$1"; }
label() { paint "1" "$1"; }

row() { printf '  %-11s %s\n' "$(label "$1")" "$2"; }

# --- daemon ---------------------------------------------------------------
SERVICE_NAME="com.echo"
SOURCE_HOME="${ECHO_SOURCE_HOME:-$HOME/Library/Application Support/echo/source}"

loaded="not loaded"
if launchctl list 2>/dev/null | grep -q "$SERVICE_NAME"; then
  loaded="loaded"
fi

health=""
if health="$(curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" 2>/dev/null)"; then
  daemon_state="$(ok "running")"
else
  daemon_state="$(bad "not running")"
fi
row "Daemon" "$daemon_state on :${ECHO_PORT}  $(dim "$loaded")"

for legacy in com.pai.voice-server com.atlas.voicesystem; do
  if launchctl list 2>/dev/null | grep -q "$legacy"; then
    row "" "$(warn "legacy service still loaded: $legacy")"
  fi
done

if [ -z "$health" ]; then
  echo
  dim "  The daemon is not answering, so there is no output state to show."
  echo
  dim "  Start it with:  echo start     Diagnose with:  echo doctor"
  echo
  exit 0
fi

# Pull the fields we render out of /health. One python pass, one line per value.
  # python3 is optional: without it these sections stay blank and status
  # still reports the daemon, which is all the port tests assert.
  fields=""
  if command -v python3 >/dev/null 2>&1; then
  fields="$(printf '%s' "$health" | python3 -c '
import json, sys
h = json.load(sys.stdin)
def g(*keys):
    v = h
    for k in keys:
        v = v.get(k) if isinstance(v, dict) else None
    return "" if v is None else str(v)
mute = h.get("mute") or {}
until = mute.get("muted_until") or ""
print("\n".join([
    g("status"), g("activeProvider"), g("mode"),
    "true" if mute.get("muted") else "false",
    str(mute.get("scope") or "all"), until,
    g("play_queue", "depth"),
    g("capture_guard", "state"),
    g("replay", "available"), g("replay", "capacity"),
    g("config", "valid"),
    ",".join(h.get("config", {}).get("ignored_keys") or []),
    ",".join(h.get("config", {}).get("retired_keys") or []),
]))
')"
  fi
val() { printf '%s' "$fields" | sed -n "${1}p"; }

status_v="$(val 1)"; provider="$(val 2)"; mode_v="$(val 3)"
muted="$(val 4)"; scope="$(val 5)"; muted_until="$(val 6)"
queue="$(val 7)"; capture="$(val 8)"
replay_n="$(val 9)"; replay_cap="$(val 10)"
config_valid="$(val 11)"; ignored="$(val 12)"; retired="$(val 13)"

# --- output ---------------------------------------------------------------
echo
printf '%s\n' "$(label "Output")"
if [ "$muted" = "true" ]; then
  mute_text="$(warn "muted") $(dim "($scope")${muted_until:+ until $muted_until}$(dim ")")"
else
  mute_text="$(ok "unmuted")"
fi
row "Mute" "$mute_text"
row "Mode" "$mode_v"
row "Provider" "$provider"
row "Queue" "$queue waiting    $(dim "replay $replay_n of $replay_cap")"
row "Capture" "$capture"

# --- providers ------------------------------------------------------------
echo
printf '%s\n' "$(label "Providers")"
  if command -v python3 >/dev/null 2>&1; then
printf '%s' "$health" | python3 -c '
import json, sys
h = json.load(sys.stdin)
color = sys.stdout.isatty() and not __import__("os").environ.get("NO_COLOR")
def p(code, text):
    return f"\033[{code}m{text}\033[0m" if color else text
for name, info in (h.get("providers") or {}).items():
    if info.get("enabled") and info.get("healthy"):
        mark = p("32", "ok")
    elif info.get("enabled"):
        mark = p("31", "unhealthy")
    else:
        mark = p("2", "off")
    print(f"  {name:<11} {mark}")
'
  fi

# --- harnesses ------------------------------------------------------------
# Same anchors scripts/install.sh uses to decide an adapter is registered.
echo
printf '%s\n' "$(label "Harnesses")"
harness() {
  # $1 name  $2 0/1 registered  $3 where
  if [ "$2" = "1" ]; then row "$1" "$(ok "registered")  $(dim "$3")";
  else row "$1" "$(dim "not registered")"; fi
}

claude_settings="$HOME/.claude/settings.json"
pi_settings="$HOME/.pi/agent/settings.json"
omp_ext="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"
jcode_config="${JCODE_CONFIG_PATH:-${JCODE_HOME:-$HOME/.jcode}/config.toml}"
grok_hooks="${ECHO_GROK_HOOKS_DIR:-${GROK_HOME:-$HOME/.grok}/hooks}"
opencode_plugins="${ECHO_OPENCODE_PLUGINS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins}"
empryo_hooks="${ECHO_EMPRYO_HOOKS_FILE:-$HOME/.empryo/hooks.json}"
codex_hooks="${ECHO_CODEX_HOOKS_FILE:-${CODEX_HOME:-$HOME/.codex}/hooks.json}"

reg() { [ -f "$1" ] && grep -qE "$2" "$1"; }

harness "Claude"  "$(reg "$claude_settings" 'adapters/claudecode/hooks/[^/"]+\.hook\.ts' && echo 1 || echo 0)" "$claude_settings"
harness "Pi"      "$(reg "$pi_settings" 'adapters/pi/' && echo 1 || echo 0)" "$pi_settings"
harness "omp"     "$([ -L "$omp_ext/echo-voice" ] && echo 1 || echo 0)" "$omp_ext"
harness "Jcode"   "$(reg "$jcode_config" 'adapters/jcode/hook\.ts' && echo 1 || echo 0)" "$jcode_config"
harness "Grok"    "$(reg "$grok_hooks/echo-voice.json" 'adapters/grok/hook\.ts' && echo 1 || echo 0)" "$grok_hooks"
harness "Codex"   "$(reg "$codex_hooks" 'adapters/codex/hook\.ts' && echo 1 || echo 0)" "$codex_hooks"
harness "OpenCode" "$([ -L "$opencode_plugins/echo-voice.ts" ] && echo 1 || echo 0)" "$opencode_plugins"
harness "Empryo"  "$(reg "$empryo_hooks" 'adapters/empryo/hook\.ts' && echo 1 || echo 0)" "$empryo_hooks"

# --- source & config ------------------------------------------------------
echo
printf '%s\n' "$(label "Install")"
if [ -d "$SOURCE_HOME" ]; then
  pkg="$(python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p.get("name","?"), p.get("version","?"))' "$SOURCE_HOME/package.json" 2>/dev/null || echo "unknown")"
  row "Source" "$pkg  $(dim "$SOURCE_HOME")"
else
  row "Source" "$(dim "no npm install — running from a checkout")"
fi
if [ "$config_valid" = "True" ] || [ "$config_valid" = "true" ]; then
  config_text="$(ok "valid")"
else
  config_text="$(bad "invalid")"
fi
[ -n "$ignored" ] && config_text="$config_text  $(warn "ignored: $ignored")"
[ -n "$retired" ] && config_text="$config_text  $(dim "retired: $retired")"
row "Config" "$config_text"

[ "$status_v" = "healthy" ] || exit 1

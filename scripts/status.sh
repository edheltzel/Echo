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
  health=""
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
  dim "  Install/re-stage:  echo install --adapter none     Diagnose:  echo doctor"
  echo
fi

fields=""
unavailable="daemon unavailable"
if [ -n "$health" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    unavailable="Bun unavailable"
  elif fields="$(printf '%s' "$health" | bun -e '
const h = await Bun.stdin.json();
if (typeof h?.status !== "string") throw new Error("Missing health status");
const g = (...keys) => keys.reduce((v, k) => v?.[k], h) ?? "";
console.log([
  g("status"), g("activeProvider"), g("mode"),
  g("mute", "muted"), g("mute", "scope"), g("mute", "muted_until"),
  g("play_queue", "depth"), g("capture_guard", "state"),
  g("config", "valid"),
  (h.config?.ignored_keys ?? []).join(","),
  (h.config?.retired_keys ?? []).join(","),
  ...Object.entries(h.providers ?? {}).map(([name, info]) =>
    `${name}\t${info.enabled ? (info.healthy ? "ok" : "unhealthy") : "off"}`),
].join("\n"));
' 2>/dev/null)"; then
    unavailable=""
  else
    fields=""
    unavailable="unreadable /health response"
  fi
fi
val() { printf '%s' "$fields" | sed -n "${1}p"; }
unknown="$(dim "unavailable${unavailable:+ ($unavailable)}")"

status_v="$(val 1)"; provider="$(val 2)"; mode_v="$(val 3)"
muted="$(val 4)"; scope="$(val 5)"; muted_until="$(val 6)"
queue="$(val 7)"; capture="$(val 8)"
config_valid="$(val 9)"; ignored="$(val 10)"; retired="$(val 11)"

# --- output ---------------------------------------------------------------
echo
printf '%s\n' "$(label "Output")"
if [ "$muted" = "true" ] || [ "$scope" = "mic" ]; then
  mute_text="$(warn "muted") $(dim "(${scope:-all}")${muted_until:+ until $muted_until}$(dim ")")"
elif [ "$muted" = "false" ]; then
  mute_text="$(ok "unmuted")"
else
  mute_text="$unknown"
fi
row "Mute" "$mute_text"
row "Mode" "${mode_v:-$unknown}"
row "Provider" "${provider:-$unknown}"
if [ -n "$queue" ]; then row "Queue" "$queue waiting";
else row "Queue" "$unknown"; fi
row "Capture" "${capture:-$unknown}"

# --- providers ------------------------------------------------------------
echo
printf '%s\n' "$(label "Providers")"
if [ -n "$unavailable" ]; then
  row "" "$unknown"
else
  while IFS=$'\t' read -r name state; do
    [ -n "$name" ] || continue
    case "$state" in
      ok) row "$name" "$(ok "$state")" ;;
      unhealthy) row "$name" "$(bad "$state")" ;;
      *) row "$name" "$(dim "$state")" ;;
    esac
  done < <(printf '%s\n' "$fields" | tail -n +12)
fi

# --- harnesses ------------------------------------------------------------
# Same anchors scripts/install.sh uses to decide an adapter is registered.
echo
printf '%s\n' "$(label "Harnesses")"
harness() {
  if [ "$2" = "1" ]; then row "$1" "$(ok "registered")  $(dim "$3")";
  elif [ "$2" = "unavailable" ]; then row "$1" "$(dim "unavailable")";
  else row "$1" "$(dim "not registered")"; fi
}

claude_settings="$HOME/.claude/settings.json"
pi_settings="${PI_SETTINGS_PATH:-$HOME/.pi/agent/settings.json}"
omp_ext="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"
jcode_config="${JCODE_CONFIG_PATH:-${JCODE_HOME:-$HOME/.jcode}/config.toml}"
grok_hooks="${ECHO_GROK_HOOKS_DIR:-${GROK_HOME:-$HOME/.grok}/hooks}"
opencode_plugins="${ECHO_OPENCODE_PLUGINS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins}"
empryo_hooks="${ECHO_EMPRYO_HOOKS_FILE:-$HOME/.empryo/hooks.json}"
if [ -n "${ECHO_CODEX_HOOKS_FILE:-}" ]; then
  codex_hooks="$ECHO_CODEX_HOOKS_FILE"
elif [ -f "$PWD/.codex/hooks.json" ]; then
  codex_hooks="$PWD/.codex/hooks.json"
else
  codex_hooks="${CODEX_HOME:-$HOME/.codex}/hooks.json"
fi
mcp_config="${ECHO_MCP_CONFIG_PATH:-$HOME/.claude.json}"

reg() { [ -f "$1" ] && grep -qE "$2" "$1"; }

jcode_registered=0
if [ -f "$jcode_config" ]; then
  if command -v bun >/dev/null 2>&1; then
    jcode_registered="$(bun -e '
const config = Bun.TOML.parse(await Bun.file(process.argv[1]).text());
console.log([config.hooks?.turn_end, config.hooks?.session_start].some(
  value => typeof value === "string" && value.includes("adapters/jcode/hook.ts")
) ? "1" : "0");
' "$jcode_config" 2>/dev/null)" || jcode_registered=unavailable
  else
    jcode_registered=unavailable
  fi
fi

harness "Claude"  "$(reg "$claude_settings" '"[^"]*/adapters/claudecode/hooks/[^/"]+\.hook\.ts"' && echo 1 || echo 0)" "$claude_settings"
harness "Pi"      "$(reg "$pi_settings" '"([^":]*/)?adapters/pi/?"' && echo 1 || echo 0)" "$pi_settings"
harness "omp"     "$([ -L "$omp_ext/echo-voice" ] && echo 1 || echo 0)" "$omp_ext"
harness "Jcode"   "$jcode_registered" "$jcode_config"
harness "Grok"    "$(reg "$grok_hooks/echo-voice.json" 'adapters/grok/hook\.ts' && echo 1 || echo 0)" "$grok_hooks"
harness "Codex"   "$(reg "$codex_hooks" 'adapters/codex/hook\.ts' && echo 1 || echo 0)" "$codex_hooks"
harness "OpenCode" "$([ -L "$opencode_plugins/echo-voice.ts" ] && echo 1 || echo 0)" "$opencode_plugins"
harness "Empryo"  "$(reg "$empryo_hooks" 'adapters/empryo/hook\.ts' && echo 1 || echo 0)" "$empryo_hooks"
harness "MCP"     "$(reg "$mcp_config" '"[^"]*/adapters/mcp/server\.ts"' && echo 1 || echo 0)" "$mcp_config"

# --- source & config ------------------------------------------------------
echo
printf '%s\n' "$(label "Install")"
if [ -d "$SOURCE_HOME" ]; then
  pkg="$(bun -e 'const p = await Bun.file(process.argv[1]).json(); console.log(p.name ?? "?", p.version ?? "?");' "$SOURCE_HOME/package.json" 2>/dev/null || echo "unknown")"
  row "Source" "$pkg  $(dim "$SOURCE_HOME")"
else
  row "Source" "$(dim "no npm install — running from a checkout")"
fi
if [ "$config_valid" = "true" ]; then
  config_text="$(ok "valid")"
elif [ "$config_valid" = "false" ]; then
  config_text="$(bad "invalid")"
else
  config_text="$unknown"
fi
[ -n "$ignored" ] && config_text="$config_text  $(warn "ignored: $ignored")"
[ -n "$retired" ] && config_text="$config_text  $(dim "retired: $retired")"
row "Config" "$config_text"

[ -z "$health" ] || [ "$status_v" = "healthy" ] || exit 1

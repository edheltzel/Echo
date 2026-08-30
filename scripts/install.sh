#!/bin/bash
set -euo pipefail

SERVICE_NAME="com.echo"
# Former labels for this service. A reinstall unloads + quarantines each so a
# running legacy service migrates cleanly onto com.echo. com.pai.voice-server is
# the original PAI-named service; com.atlas.voicesystem is the prior "Atlas" name.
LEGACY_SERVICE_NAMES=("com.pai.voice-server" "com.atlas.voicesystem")
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LOG_PATH="$HOME/Library/Logs/echo.log"
# Sets ECHO_PORT (config.json, deprecated process PORT, then 3246) and its URLs.
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"
# Versioned daemon payload — a self-contained copy of core/ + shared/ under a
# user-owned application-support directory, NOT the git clone. The LaunchAgent
# points at ${PAYLOAD_CURRENT}, so moving or deleting the checkout never breaks
# the running service (Stage 1). `current` is a symlink to the active version,
# so `echo update` just re-stages + repoints it.
#
# It lives in its OWN `payload/` subdir under `.../Application Support/echo` (the
# lowercase state dir that also holds mute.json). The case-insensitive default
# volume means `Echo` and `echo` are the same directory, so isolating the payload
# in a subdir is what lets uninstall remove it without touching sibling state.
PAYLOAD_HOME="$HOME/Library/Application Support/echo/payload"
PAYLOAD_VERSIONS="$PAYLOAD_HOME/versions"
PAYLOAD_CURRENT="$PAYLOAD_HOME/current"
# Payload copy that was live before this run; `current` is restored to it when the
# reload cannot prove the newly staged one healthy. Empty on a first install.
PAYLOAD_ROLLBACK=""
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
CLAUDE_COMMANDS_DIR="${ECHO_CLAUDE_COMMANDS_DIR:-$HOME/.claude/commands}"
PI_SETTINGS="$HOME/.pi/agent/settings.json"
CLAUDE_MCP_CONFIG="${ECHO_MCP_CONFIG_PATH:-$HOME/.claude.json}"
JCODE_CONFIG="${JCODE_CONFIG_PATH:-${JCODE_HOME:-$HOME/.jcode}/config.toml}"
# adapters/omp/reconcile.ts honors the same override, so detection and reconcile agree.
OMP_EXTENSIONS="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"
# adapters/grok/reconcile.ts honors GROK_HOME / ECHO_GROK_HOOKS_DIR the same way.
GROK_HOOKS="${ECHO_GROK_HOOKS_DIR:-${GROK_HOME:-$HOME/.grok}/hooks}"
# adapters/opencode/reconcile.ts honors ECHO_OPENCODE_PLUGINS_DIR / XDG_CONFIG_HOME.
OPENCODE_PLUGINS="${ECHO_OPENCODE_PLUGINS_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins}"
OPENCODE_PLUGIN_LINK="$OPENCODE_PLUGINS/echo-voice.ts"
ADAPTER="none"
CHECK_ONLY=0

usage() {
  cat <<EOF
Usage: scripts/install.sh [--adapter none|claudecode|jcode|grok|codex|mcp|pi|omp|opencode] [--check]

Installs the universal echo core as a macOS LaunchAgent.
Adapter registration is optional and runs only after adapter preflight passes.
Every run also re-reconciles all already-installed adapter registrations, so a
repo directory rename heals with one rerun (#77).
--check reports stale echo-related paths across the plist and host settings
without mutating anything. Exit 0 when everything is current, 3 when stale
paths were detected. It checks that those paths still resolve — it does not
compare the staged payload's contents against this checkout.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --adapter)
      ADAPTER="${2:-}"
      shift 2
      ;;
    --adapter=*)
      ADAPTER="${1#--adapter=}"
      shift
      ;;
    --check)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$ADAPTER" in
  none|claudecode|jcode|grok|codex|mcp|pi|omp|opencode) ;;
  *)
    echo "Unknown adapter: $ADAPTER" >&2
    usage >&2
    exit 2
    ;;
esac

is_loaded() {
  launchctl list 2>/dev/null | grep "$1" >/dev/null 2>&1
}

# Read the payload version from a package.json WITHOUT invoking bun — the daemon
# payload is named by version, and install must stage it even when bun is absent.
read_payload_version() {
  { sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -1; } || true
}

# True when Echo's daemon answers /health on the configured port.
health_ok() {
  command -v curl >/dev/null 2>&1 || return 1
  curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null 2>&1
}

# Refuse to install onto a port that is occupied by something not answering
# /health, whoever owns it. Echo's invariant forbids broad-killing the port
# owner, and it does not guess whether the owner is its own daemon — it reports
# what lsof saw and both recoveries (scripts/echo-port.sh), which doctor prints
# verbatim too. A healthy daemon short-circuits at health_ok, so an ordinary
# reinstall never reaches here; if lsof is unavailable we cannot see the port at
# all, so we never block.
check_port_owner() {
  if health_ok; then return 0; fi
  command -v lsof >/dev/null 2>&1 || return 0
  [ -n "$(port_listener_pids)" ] || return 0

  port_occupied_summary >&2
  lsof -nP -iTCP:"${ECHO_PORT}" -sTCP:LISTEN >&2 || true
  port_occupied_advice >&2
  echo "Refusing to install over it. Diagnose with: cli/echo doctor" >&2
  exit 1
}

# Stage a versioned, self-contained daemon payload (core/ + shared/) under
# ${PAYLOAD_HOME} and atomically repoint ${PAYLOAD_CURRENT} at it. The copy is
# what lets the daemon survive a checkout move/removal. Pure cp/sed/mkdir/ln/mv —
# no bun — so it runs before the daemon (and its runtime) even exist.
stage_payload() {
  local version ver_dir stage keep live
  version="$(read_payload_version "$REPO_ROOT/package.json")"
  if [ -z "$version" ]; then
    echo "Could not read version from $REPO_ROOT/package.json — cannot stage payload." >&2
    exit 1
  fi
  ver_dir="$PAYLOAD_VERSIONS/$version"
  stage="$PAYLOAD_HOME/.stage.$$"
  keep="$PAYLOAD_VERSIONS/.rollback.$$"

  echo "> Staging Echo payload v$version → $ver_dir"
  mkdir -p "$PAYLOAD_VERSIONS"
  rm -rf "$stage"
  mkdir -p "$stage"
  cp -R "$REPO_ROOT/core" "$stage/core"
  cp -R "$REPO_ROOT/shared" "$stage/shared"
  cat > "$stage/manifest.json" <<EOF
{
  "name": "echo",
  "version": "$version",
  "service": "$SERVICE_NAME",
  "staged_from": "$REPO_ROOT"
}
EOF
  # Preserve whatever the daemon is running today as the rollback target. On a
  # version bump the live dir is a different version and survives untouched; a
  # same-version re-stage (the `echo update` path) would otherwise delete the only
  # working copy, so it is renamed aside instead of removed.
  live=""
  if [ -L "$PAYLOAD_CURRENT" ]; then live="$(readlink "$PAYLOAD_CURRENT")"; fi
  if [ -n "$live" ] && [ "$live" != "$ver_dir" ] && [ -d "$live" ]; then
    PAYLOAD_ROLLBACK="$live"
  elif [ -d "$ver_dir" ]; then
    rm -rf "$keep"
    mv "$ver_dir" "$keep"
    PAYLOAD_ROLLBACK="$keep"
  fi

  rm -rf "$ver_dir"
  mv "$stage" "$ver_dir"
  ln -sfn "$ver_dir" "$PAYLOAD_CURRENT"
}

# A failed reload must never leave `current` pinned to a payload the daemon cannot
# run, with KeepAlive respawning it: repoint `current` at the copy that was live
# before this run and reload that, so the operator is left on a working daemon.
rollback_payload() {
  if [ -z "$PAYLOAD_ROLLBACK" ] || [ ! -d "$PAYLOAD_ROLLBACK" ]; then
    echo "No previously working payload to roll back to — leaving the newly staged one in place." >&2
    return 0
  fi
  echo "> Rolling back payload to $PAYLOAD_ROLLBACK" >&2
  ln -sfn "$PAYLOAD_ROLLBACK" "$PAYLOAD_CURRENT"
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  launchctl load "$PLIST_PATH" 2>/dev/null || true
  sleep 2
  if health_ok; then
    echo "Restored the payload that was running before this install. Check logs: $LOG_PATH" >&2
  else
    echo "ROLLBACK INCOMPLETE: the restored payload did not answer /health on :${ECHO_PORT} either." >&2
    echo "Echo has no working daemon right now. Check logs: $LOG_PATH" >&2
  fi
}

# Only the renamed-aside copy is ours to delete; a real prior version dir stays.
discard_rollback_copy() {
  case "$PAYLOAD_ROLLBACK" in
    "$PAYLOAD_VERSIONS"/.rollback.*) rm -rf "$PAYLOAD_ROLLBACK" ;;
  esac
  PAYLOAD_ROLLBACK=""
}

# Detection mirrors the reconcilers' matchers (a JSON string holding a hook command under
# adapters/claudecode/hooks/, or a scheme-free packages entry ending in adapters/pi), so a
# host config that merely mentions a similar substring is never touched by refresh-all.
claudecode_installed() {
  [ -f "$CLAUDE_SETTINGS" ] && grep -qE '"[^"]*/adapters/claudecode/hooks/[^/"]+\.hook\.ts"' "$CLAUDE_SETTINGS"
}

claudecode_commands_installed() {
  local entry target
  for entry in "$CLAUDE_COMMANDS_DIR/echo-voice.md" "$CLAUDE_COMMANDS_DIR/echo-mute.md"; do
    [ -L "$entry" ] || continue
    target="$(readlink "$entry" 2>/dev/null || true)"
    case "$target" in
      */adapters/claudecode/commands/echo-voice.md|*/adapters/claudecode/commands/echo-mute.md) return 0 ;;
    esac
  done
  return 1
}

# Anchored to the server path echo owns: present even when the path is dead
# (a renamed clone), which is the state refresh-all has to heal.
mcp_installed() {
  [ -f "$CLAUDE_MCP_CONFIG" ] && grep -qE '"[^"]*/adapters/mcp/server\.ts"' "$CLAUDE_MCP_CONFIG"
}

pi_installed() {
  [ -f "$PI_SETTINGS" ] && grep -qE '"([^":]*/)?adapters/pi/?"' "$PI_SETTINGS"
}

# Anchored to the one entry Echo owns (#18): the echo-voice symlink — present
# even when its target is dead (a renamed clone), which is exactly the state
# refresh-all must heal. Foreign entries never trigger detection.
omp_installed() {
  [ -L "$OMP_EXTENSIONS/echo-voice" ]
}

jcode_installed() {
  if [ -L "$JCODE_CONFIG" ] && [ ! -e "$JCODE_CONFIG" ]; then
    return 0
  fi
  [ -f "$JCODE_CONFIG" ] && grep -qE '^[[:space:]]*((turn_end|session_start)|hooks\.(turn_end|session_start)|hooks[[:space:]]*=).*adapters/jcode/hook\.ts' "$JCODE_CONFIG"
}

# Anchored to the one Echo-owned file under global Grok hooks: present even when
# its target path is dead (a renamed clone), which is the state refresh-all heals.
# Sibling files (fm-turn-end.json, etc.) never trigger detection.
grok_installed() {
  if [ -L "$GROK_HOOKS/echo-voice.json" ] && [ ! -e "$GROK_HOOKS/echo-voice.json" ]; then
    return 0
  fi
  [ -f "$GROK_HOOKS/echo-voice.json" ] && grep -qE 'adapters/grok/hook\.ts' "$GROK_HOOKS/echo-voice.json"
}

# Codex hooks live in a single hooks.json (project .codex/hooks.json or ~/.codex/hooks.json).
codex_hooks_file() {
  if [ -n "${ECHO_CODEX_HOOKS_FILE:-}" ]; then
    printf '%s\n' "$ECHO_CODEX_HOOKS_FILE"
    return 0
  fi
  if [ -f "$REPO_ROOT/.codex/hooks.json" ]; then
    printf '%s\n' "$REPO_ROOT/.codex/hooks.json"
    return 0
  fi
  printf '%s\n' "${CODEX_HOME:-$HOME/.codex}/hooks.json"
}

codex_installed() {
  local f
  f="$(codex_hooks_file)"
  [ -f "$f" ] && grep -qE 'adapters/codex/hook\.ts' "$f"
}

opencode_installed() {
  if [ -L "$OPENCODE_PLUGIN_LINK" ] && [ ! -e "$OPENCODE_PLUGIN_LINK" ]; then
    return 0
  fi
  [ -L "$OPENCODE_PLUGIN_LINK" ]
}

# Materialize the workspace links every adapter depends on. Each adapter package
# declares `@echo/shared` as a dependency instead of reaching up the tree, so
# `bun install` must have run before a host can load one. Idempotent and offline —
# every workspace member is local, so this makes no network request.
#
# ECHO_SKIP_WORKSPACE_LINK=1 opts a run out of managing the links entirely — it
# neither creates them here nor verifies them in check_installation. It exists so
# tests can drive install.sh without `bun install` mutating the checkout's
# node_modules mid-`bun test`; it is not a supported way to install.
skip_workspace_link() {
  [ "${ECHO_SKIP_WORKSPACE_LINK:-0}" = "1" ]
}

link_workspace() {
  if skip_workspace_link; then
    echo "> Skipping workspace link (ECHO_SKIP_WORKSPACE_LINK=1)"
    return 0
  fi
  echo "> Linking workspace packages (@echo/shared)"
  (cd "$REPO_ROOT" && bun install --frozen-lockfile) >/dev/null
}

# Drain legacy dotenv Echo settings into ~/.config/echo/config.json before
# anything resolves a port. A dotenv PORT is invisible to every bash surface (and
# to the daemon, which no longer honors it there), so migrating first is what
# keeps an upgrading user on the port they configured instead of failing the
# health probe on :3246. Reporting, non-destructive scope, and the
# ELEVENLABS_API_KEY carve-out live in the script; re-source echo-port.sh after
# it so ECHO_PORT reflects a freshly migrated value.
migrate_legacy_config() {
  bun run "$REPO_ROOT/scripts/migrate-config.ts"
  # shellcheck source=scripts/echo-port.sh
  . "$SCRIPT_DIR/echo-port.sh"
}

preflight() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required. Install it from https://bun.sh/" >&2
    exit 1
  fi

  migrate_legacy_config
  link_workspace

  case "$ADAPTER" in
    claudecode)
      echo "> Preflighting Claude Code adapter hook registration"
      # --check exits 3 when changes are pending — normal before an install; only
      # a real failure (unparseable settings, missing Bash matcher) aborts.
      bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts" --check >/dev/null || [ $? -eq 3 ]
      echo "> Preflighting Claude Code slash-command registration"
      bun run "$REPO_ROOT/adapters/claudecode/reconcile-commands.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
    mcp)
      echo "> Preflighting MCP server registration"
      # Exit 3 (changes pending) is normal before an install; exit 2 (FATAL, a
      # foreign server occupying the echo-converse name) must abort BEFORE any
      # host state is mutated.
      bun run "$REPO_ROOT/adapters/mcp/reconcile.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
    pi)
      if ! command -v pi >/dev/null 2>&1; then
        echo "Pi CLI is required for --adapter pi" >&2
        exit 1
      fi
      ;;
    omp)
      if ! command -v omp >/dev/null 2>&1; then
        echo "omp CLI is required for --adapter omp" >&2
        exit 1
      fi
      echo "> Preflighting oh-my-pi adapter registration"
      # Exit 3 (changes pending) is normal before an install; exit 2 (FATAL,
      # e.g. a foreign entry occupying echo-voice) must abort BEFORE any host
      # state is mutated.
      bun run "$REPO_ROOT/adapters/omp/reconcile.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
    jcode)
      if ! command -v jcode >/dev/null 2>&1; then
        echo "Jcode CLI is required for --adapter jcode" >&2
        exit 1
      fi
      echo "> Preflighting Jcode lifecycle-hook registration"
      bun run "$REPO_ROOT/adapters/jcode/reconcile.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
    grok)
      if ! command -v grok >/dev/null 2>&1; then
        echo "Grok Build CLI is required for --adapter grok" >&2
        exit 1
      fi
      echo "> Preflighting Grok Build lifecycle-hook registration"
      bun run "$REPO_ROOT/adapters/grok/reconcile.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
    codex)
      if ! command -v codex >/dev/null 2>&1; then
        echo "Codex CLI is required for --adapter codex" >&2
        exit 1
      fi
      echo "> Preflighting Codex lifecycle-hook registration"
      bun run "$REPO_ROOT/adapters/codex/reconcile.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
    opencode)
      if ! command -v opencode >/dev/null 2>&1; then
        echo "OpenCode CLI is required for --adapter opencode" >&2
        exit 1
      fi
      echo "> Preflighting OpenCode plugin registration"
      bun run "$REPO_ROOT/adapters/opencode/reconcile.ts" --check >/dev/null || [ $? -eq 3 ]
      ;;
  esac

  # echo-converse's capture tools are diagnosed here, never enforced. These
  # adapters register the echo_ask tool, but voice-ask is optional and the
  # daemon they are installing alongside does not need sox at all - failing the
  # base install over it would break an operator who only wants notifications.
  # The hard, actionable error still fires at call time (converse/capture.ts
  # refuses before spawning, naming the binary and `brew install sox`).
  case "$ADAPTER" in
    mcp|pi|omp)
      echo "> Checking echo-converse capture dependencies"
      bash "$SCRIPT_DIR/converse-dependencies.sh" \
        || echo "WARN: echo-converse voice-ask will fail until its capture tools are installed; the daemon is unaffected" >&2
      ;;
  esac

  # Last: refuse a foreign-owned port before any host state is mutated. Placed
  # after the adapter checks so an adapter-preflight failure surfaces first.
  check_port_owner
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  local tmp_plist="${PLIST_PATH}.tmp.$$"

  # EnvironmentVariables stays HOME + PATH. PORT is deliberately NOT written: the
  # plist is rewritten wholesale on every run, so baking in an ambient shell PORT
  # would silently move the daemon on one install and silently move it back on the
  # next.
  cat > "$tmp_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(command -v bun)</string>
        <string>run</string>
        <string>${PAYLOAD_CURRENT}/core/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PAYLOAD_CURRENT}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>StandardOutPath</key>
    <string>${LOG_PATH}</string>
    <key>StandardErrorPath</key>
    <string>${LOG_PATH}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:${HOME}/.bun/bin</string>
    </dict>
</dict>
</plist>
EOF

  mv "$tmp_plist" "$PLIST_PATH"
  rm -f "$tmp_plist"
}

migrate_legacy_service() {
  for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
    local legacy_plist="$HOME/Library/LaunchAgents/${legacy}.plist"

    if is_loaded "$legacy"; then
      echo "> Unloading legacy voice service ($legacy)"
      launchctl unload "$legacy_plist" 2>/dev/null || true
      sleep 1
      if is_loaded "$legacy"; then
        echo "Legacy service is still loaded after unload: $legacy" >&2
        exit 1
      fi
    fi

    if [ -f "$legacy_plist" ]; then
      local stamp backup
      stamp="$(date +%Y%m%d%H%M%S)"
      backup="${legacy_plist}.migrated-${stamp}"
      echo "> Quarantining legacy LaunchAgent plist: $backup"
      mv "$legacy_plist" "$backup"
    fi
  done
}

# Returns non-zero (never exits) so the caller can roll the payload back first.
# Every failure path returns explicitly — errexit is suppressed inside a function
# used as a condition, so a bare failing command here would fall through.
reload_core_service() {
  if is_loaded "$SERVICE_NAME"; then
    echo "> Reloading existing $SERVICE_NAME"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  echo "> Loading $SERVICE_NAME"
  if ! launchctl load "$PLIST_PATH"; then
    echo "launchctl could not load $PLIST_PATH" >&2
    return 1
  fi
  sleep 2

  if ! is_loaded "$SERVICE_NAME"; then
    echo "LaunchAgent did not remain loaded: $SERVICE_NAME" >&2
    return 1
  fi

  for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
    if is_loaded "$legacy"; then
      echo "Legacy service unexpectedly loaded after migration: $legacy" >&2
      return 1
    fi
  done

  if health_ok; then
    echo "OK echo is healthy on :${ECHO_PORT}"
  else
    echo "Voice server did not respond on :${ECHO_PORT}. Check logs: $LOG_PATH" >&2
    return 1
  fi
}

install_adapter() {
  case "$ADAPTER" in
    claudecode)
      echo "> Installing Claude Code adapter hook registrations"
      bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts"
      echo "> Reconciling Claude Code slash commands"
      bun run "$REPO_ROOT/adapters/claudecode/reconcile-commands.ts"
      ;;
    mcp)
      echo "> Registering the echo-converse MCP server"
      bun run "$REPO_ROOT/adapters/mcp/reconcile.ts"
      ;;
    pi)
      echo "> Installing Pi adapter package"
      pi install "$REPO_ROOT/adapters/pi"
      # pi install appends; reconcile so a stale entry from a renamed clone can't
      # survive beside the fresh one (#77).
      echo "> Reconciling Pi adapter registration"
      bun run "$REPO_ROOT/adapters/pi/reconcile.ts"
      ;;
    omp)
      echo "> Reconciling oh-my-pi adapter registration"
      bun run "$REPO_ROOT/adapters/omp/reconcile.ts"
      ;;
    jcode)
      echo "> Reconciling Jcode lifecycle-hook registration"
      bun run "$REPO_ROOT/adapters/jcode/reconcile.ts"
      ;;
    grok)
      echo "> Reconciling Grok Build lifecycle-hook registration"
      bun run "$REPO_ROOT/adapters/grok/reconcile.ts"
      ;;
    codex)
      echo "> Reconciling Codex lifecycle-hook registration"
      bun run "$REPO_ROOT/adapters/codex/reconcile.ts"
      ;;
    opencode)
      echo "> Reconciling OpenCode plugin registration"
      bun run "$REPO_ROOT/adapters/opencode/reconcile.ts"
      ;;
  esac
}

refresh_installed_adapters() {
  # A directory rename leaves stale paths in every registered host config (#77):
  # re-reconcile each installed adapter on every run, regardless of --adapter.
  # A broken secondary adapter config must not fail the requested install — warn instead.
  if [ "$ADAPTER" != "claudecode" ]; then
    if claudecode_installed; then
      echo "> Refreshing Claude Code adapter hook registrations"
      bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts" \
        || echo "WARN: Claude Code hook refresh failed — run adapters/claudecode/restore-hooks.ts manually" >&2
    fi
    if claudecode_installed || claudecode_commands_installed; then
      echo "> Refreshing Claude Code slash-command registrations"
      bun run "$REPO_ROOT/adapters/claudecode/reconcile-commands.ts" \
        || echo "WARN: Claude Code slash-command refresh failed — run adapters/claudecode/reconcile-commands.ts manually" >&2
    fi
  fi
  if [ "$ADAPTER" != "mcp" ] && mcp_installed; then
    echo "> Refreshing MCP server registration"
    bun run "$REPO_ROOT/adapters/mcp/reconcile.ts" \
      || echo "WARN: MCP registration refresh failed - run adapters/mcp/reconcile.ts manually" >&2
  fi
  if [ "$ADAPTER" != "pi" ] && pi_installed; then
    echo "> Refreshing Pi adapter registration"
    bun run "$REPO_ROOT/adapters/pi/reconcile.ts" \
      || echo "WARN: Pi registration refresh failed — run adapters/pi/reconcile.ts manually" >&2
  fi
  if [ "$ADAPTER" != "omp" ] && omp_installed; then
    echo "> Refreshing oh-my-pi adapter registration"
    bun run "$REPO_ROOT/adapters/omp/reconcile.ts" \
      || echo "WARN: omp registration refresh failed — run adapters/omp/reconcile.ts manually" >&2
  fi
  if [ "$ADAPTER" != "jcode" ] && jcode_installed; then
    echo "> Refreshing Jcode lifecycle-hook registration"
    bun run "$REPO_ROOT/adapters/jcode/reconcile.ts" \
      || echo "WARN: Jcode registration refresh failed — run adapters/jcode/reconcile.ts manually" >&2
  fi
  if [ "$ADAPTER" != "grok" ] && grok_installed; then
    echo "> Refreshing Grok Build lifecycle-hook registration"
    bun run "$REPO_ROOT/adapters/grok/reconcile.ts" \
      || echo "WARN: Grok registration refresh failed - run adapters/grok/reconcile.ts manually" >&2
  fi
  if [ "$ADAPTER" != "codex" ] && codex_installed; then
    echo "> Refreshing Codex lifecycle-hook registration"
    bun run "$REPO_ROOT/adapters/codex/reconcile.ts" \
      || echo "WARN: Codex registration refresh failed - run adapters/codex/reconcile.ts manually" >&2
  fi
  if [ "$ADAPTER" != "opencode" ] && opencode_installed; then
    echo "> Refreshing OpenCode plugin registration"
    bun run "$REPO_ROOT/adapters/opencode/reconcile.ts" \
      || echo "WARN: OpenCode registration refresh failed - run adapters/opencode/reconcile.ts manually" >&2
  fi
}

# --check report: one harness heading, then checkboxes for each item under it.
# Harness names use bold palette cyan (SGR 36) so they follow the terminal
# color scheme instead of a hardcoded RGB. NO_COLOR or a non-TTY stdout
# prints the same tree without escapes.
check_use_color() {
  [ -t 1 ] && [ -z "${NO_COLOR:-}" ]
}

print_harness() {
  if check_use_color; then
    printf 'Checking \033[1;36m%s\033[0m\n' "$1"
  else
    printf 'Checking %s\n' "$1"
  fi
}

print_checkbox() {
  local mark
  case "$1" in
    1|x) mark="x" ;;
    partial) mark="\\" ;;
    *) mark=" " ;;
  esac
  printf '  [%s] %s\n' "$mark" "$2"
}

indent_check_details() {
  sed '/./s/^/      /'
}

workspace_link_ok() {
  skip_workspace_link && return 0
  [ -e "$REPO_ROOT/adapters/$1/node_modules/@echo/shared" ]
}

report_workspace() {
  if skip_workspace_link; then
    return 0
  fi
  if workspace_link_ok "$1"; then
    print_checkbox 1 "Workspace link"
    return 0
  fi
  print_checkbox 0 "Workspace link"
  printf '      STALE %s: missing @echo/shared workspace link\n' "$REPO_ROOT/adapters/$1"
  stale=1
}

begin_harness() {
  if [ "${CHECK_SECTION:-0}" -eq 1 ]; then
    printf '\n'
  fi
  CHECK_SECTION=1
  print_harness "$1"
}

# $1 checkbox label  $2 adapter --check exit  $3 captured stdout  $4 warn text
# Registration is [x] when current, [\] when some Echo-owned items exist but
# still need reconcile, [ ] when nothing of ours is installed yet (or the
# check itself failed).
apply_adapter_check() {
  local label="$1" rc="$2" out="$3" warn="$4"
  if [ "$rc" -eq 0 ]; then
    print_checkbox x "$label"
  elif [ "$rc" -eq 3 ] && adapter_check_partial "$out"; then
    print_checkbox partial "$label"
    stale=1
  else
    print_checkbox empty "$label"
    stale=1
    if [ "$rc" -ne 3 ]; then
      echo "WARN: $warn" >&2
    fi
  fi
  if [ -n "$out" ]; then
    printf '%s\n' "$out" | indent_check_details
  fi
}

# True when --check output shows an existing Echo-owned item plus pending work.
# Foreign-file notes (Grok's "leaving N non-Echo … untouched") are not ours.
adapter_check_partial() {
  printf '%s\n' "$1" | grep -qE '^~|^- |^pending: repoint|already has|[[:space:]]already current'
}

check_installation() {
  local stale=0
  local rc out
  CHECK_SECTION=0

  begin_harness "Echo"
  if [ -f "$PLIST_PATH" ]; then
    local server_path workdir path plist_ok=1 stale_paths=""
    server_path="$(sed -n 's|.*<string>\(.*core/server\.ts\)</string>.*|\1|p' "$PLIST_PATH")"
    workdir="$(grep -A1 '<key>WorkingDirectory</key>' "$PLIST_PATH" | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' || true)"
    for path in "$server_path" "$workdir"; do
      if [ -n "$path" ] && [ ! -e "$path" ]; then
        stale_paths="${stale_paths}      STALE ${PLIST_PATH}: $path"$'\n'
        plist_ok=0
        stale=1
      fi
    done
    if [ "$plist_ok" -eq 1 ]; then
      print_checkbox x "LaunchAgent"
    else
      print_checkbox partial "LaunchAgent"
    fi
    printf '      %s\n' "$PLIST_PATH"
    if [ -n "$stale_paths" ]; then
      printf '%s' "$stale_paths"
    fi
  else
    print_checkbox 0 "LaunchAgent"
    printf '      = no %s — core not installed\n' "$PLIST_PATH"
  fi

  # --check is read-only and always reports: a failing adapter check must not
  # abort the remaining checks. Adapter --check exits 3 when changes are pending.
  local show_claude=0 claude_hooks=0 claude_commands=0
  claudecode_installed && claude_hooks=1
  claudecode_commands_installed && claude_commands=1
  [ "$ADAPTER" = "claudecode" ] && show_claude=1
  [ "$claude_hooks" -eq 1 ] && show_claude=1
  [ "$claude_commands" -eq 1 ] && show_claude=1
  mcp_installed && show_claude=1
  if ! skip_workspace_link && ! workspace_link_ok claudecode; then
    show_claude=1
  fi
  if [ "$show_claude" -eq 1 ]; then
    begin_harness "Claude Code"
    report_workspace claudecode
    if [ "$ADAPTER" = "claudecode" ] || [ "$claude_hooks" -eq 1 ]; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "Claude Code hook check failed"
    fi
    if [ "$ADAPTER" = "claudecode" ] || [ "$claude_hooks" -eq 1 ] || [ "$claude_commands" -eq 1 ]; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/claudecode/reconcile-commands.ts" --check)" || rc=$?
      apply_adapter_check "Slash commands" "$rc" "$out" "Claude Code slash-command check failed"
    fi
    if mcp_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/mcp/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "MCP server" "$rc" "$out" "MCP registration check failed"
    fi
  fi

  local show_pi=0
  pi_installed && show_pi=1
  if ! skip_workspace_link && ! workspace_link_ok pi; then
    show_pi=1
  fi
  if [ "$show_pi" -eq 1 ]; then
    begin_harness "Pi"
    report_workspace pi
    if pi_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/pi/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "Pi registration check failed"
    fi
  fi

  local show_omp=0
  omp_installed && show_omp=1
  if ! skip_workspace_link && ! workspace_link_ok omp; then
    show_omp=1
  fi
  if [ "$show_omp" -eq 1 ]; then
    begin_harness "oh-my-pi"
    report_workspace omp
    if omp_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/omp/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "omp registration check failed"
    fi
  fi

  local show_jcode=0
  jcode_installed && show_jcode=1
  if ! skip_workspace_link && ! workspace_link_ok jcode; then
    show_jcode=1
  fi
  if [ "$show_jcode" -eq 1 ]; then
    begin_harness "Jcode"
    report_workspace jcode
    if jcode_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/jcode/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "Jcode registration check failed"
    fi
  fi

  # Check the requested adapter even before first install so
  # `install.sh --adapter grok --check` reports pending registration as exit 3.
  local show_grok=0
  [ "$ADAPTER" = "grok" ] && show_grok=1
  grok_installed && show_grok=1
  if ! skip_workspace_link && ! workspace_link_ok grok; then
    show_grok=1
  fi
  if [ "$show_grok" -eq 1 ]; then
    begin_harness "Grok Build"
    report_workspace grok
    if [ "$ADAPTER" = "grok" ] || grok_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/grok/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "Grok registration check failed"
    fi
  fi

  local show_codex=0
  [ "$ADAPTER" = "codex" ] && show_codex=1
  codex_installed && show_codex=1
  if ! skip_workspace_link && ! workspace_link_ok codex; then
    show_codex=1
  fi
  if [ "$show_codex" -eq 1 ]; then
    begin_harness "Codex"
    report_workspace codex
    if [ "$ADAPTER" = "codex" ] || codex_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/codex/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "Codex registration check failed"
    fi
  fi

  local show_opencode=0
  [ "$ADAPTER" = "opencode" ] && show_opencode=1
  opencode_installed && show_opencode=1
  if ! skip_workspace_link && ! workspace_link_ok opencode; then
    show_opencode=1
  fi
  if [ "$show_opencode" -eq 1 ]; then
    begin_harness "OpenCode"
    report_workspace opencode
    if [ "$ADAPTER" = "opencode" ] || opencode_installed; then
      rc=0
      out="$(bun run "$REPO_ROOT/adapters/opencode/reconcile.ts" --check)" || rc=$?
      apply_adapter_check "Adapter registration" "$rc" "$out" "OpenCode registration check failed"
    fi
  fi

  if [ "$stale" -eq 1 ]; then
    echo "Stale paths found — rerun scripts/install.sh to reconcile." >&2
    exit 3
  fi
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required. Install it from https://bun.sh/" >&2
    exit 1
  fi
  check_installation
  exit 0
fi

preflight
stage_payload
write_plist
migrate_legacy_service
if ! reload_core_service; then
  rollback_payload
  exit 1
fi
discard_rollback_copy
install_adapter
refresh_installed_adapters

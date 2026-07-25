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
# Sets ECHO_PORT (PORT when exported, else 3246) and its URLs. No env-file reading.
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
PI_SETTINGS="$HOME/.pi/agent/settings.json"
# adapters/omp/reconcile.ts honors the same override, so detection and reconcile agree.
OMP_EXTENSIONS="${OMP_EXTENSIONS_DIR:-$HOME/.omp/agent/extensions}"
ADAPTER="none"
CHECK_ONLY=0

usage() {
  cat <<EOF
Usage: scripts/install.sh [--adapter none|claudecode|pi|omp] [--check]

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
  none|claudecode|pi|omp) ;;
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
  if [ -n "${PORT:-}" ]; then
    echo "PORT=${PORT} is exported in this shell, so this checked :${ECHO_PORT} instead of" >&2
    echo "Echo's default. Unset PORT and rerun to target the default." >&2
  fi
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

pi_installed() {
  [ -f "$PI_SETTINGS" ] && grep -qE '"([^":]*/)?adapters/pi/?"' "$PI_SETTINGS"
}

# Anchored to the one entry Echo owns (#18): the echo-voice symlink — present
# even when its target is dead (a renamed clone), which is exactly the state
# refresh-all must heal. Foreign entries never trigger detection.
omp_installed() {
  [ -L "$OMP_EXTENSIONS/echo-voice" ]
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
    if [ -n "${PORT:-}" ]; then
      echo "PORT=${PORT} is exported in this shell, so this check probed :${ECHO_PORT}" >&2
      echo "instead of Echo's default. Unset PORT and rerun to target the default." >&2
    fi
    return 1
  fi
}

# Symlink the Claude Code slash commands into ~/.claude/commands. `ln -sfn` is
# idempotent and re-points at the current repo path, so a repo move heals with a
# rerun (#77). Repo-owned source stays the single source of truth.
link_claudecode_commands() {
  local commands_dir="$HOME/.claude/commands"
  mkdir -p "$commands_dir"
  local src
  for src in "$REPO_ROOT/adapters/claudecode/commands/"*.md; do
    [ -e "$src" ] || continue
    ln -sfn "$src" "$commands_dir/$(basename "$src")"
  done
}

install_adapter() {
  case "$ADAPTER" in
    claudecode)
      echo "> Installing Claude Code adapter hook registrations"
      bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts"
      echo "> Linking Claude Code slash commands"
      link_claudecode_commands
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
  esac
}

refresh_installed_adapters() {
  # A directory rename leaves stale paths in every registered host config (#77):
  # re-reconcile each installed adapter on every run, regardless of --adapter.
  # A broken secondary adapter config must not fail the requested install — warn instead.
  if [ "$ADAPTER" != "claudecode" ] && claudecode_installed; then
    echo "> Refreshing Claude Code adapter hook registrations"
    bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts" \
      || echo "WARN: Claude Code hook refresh failed — run adapters/claudecode/restore-hooks.ts manually" >&2
    link_claudecode_commands
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
}

check_installation() {
  local stale=0

  # Adapters resolve `@echo/shared` through their own node_modules; without the
  # workspace links a registered adapter fails to load. Report, never mutate.
  local adapter
  if ! skip_workspace_link; then
    for adapter in claudecode omp pi; do
      if [ ! -e "$REPO_ROOT/adapters/$adapter/node_modules/@echo/shared" ]; then
        echo "STALE $REPO_ROOT/adapters/$adapter: missing @echo/shared workspace link"
        stale=1
      fi
    done
  fi

  if [ -f "$PLIST_PATH" ]; then
    echo "> Checking $PLIST_PATH"
    local server_path workdir path
    server_path="$(sed -n 's|.*<string>\(.*core/server\.ts\)</string>.*|\1|p' "$PLIST_PATH")"
    workdir="$(grep -A1 '<key>WorkingDirectory</key>' "$PLIST_PATH" | sed -n 's|.*<string>\(.*\)</string>.*|\1|p' || true)"
    for path in "$server_path" "$workdir"; do
      if [ -n "$path" ] && [ ! -e "$path" ]; then
        echo "STALE ${PLIST_PATH}: $path"
        stale=1
      fi
    done
  else
    echo "= no $PLIST_PATH — core not installed"
  fi

  # --check is read-only and always reports: a failing adapter check must not
  # abort the remaining checks. Adapter --check exits 3 when changes are pending.
  local rc
  if claudecode_installed; then
    echo "> Checking Claude Code adapter hook registrations"
    rc=0
    bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts" --check || rc=$?
    if [ "$rc" -eq 3 ]; then
      stale=1
    elif [ "$rc" -ne 0 ]; then
      echo "WARN: Claude Code hook check failed" >&2
      stale=1
    fi
  fi

  if pi_installed; then
    echo "> Checking Pi adapter registration"
    rc=0
    bun run "$REPO_ROOT/adapters/pi/reconcile.ts" --check || rc=$?
    if [ "$rc" -eq 3 ]; then
      stale=1
    elif [ "$rc" -ne 0 ]; then
      echo "WARN: Pi registration check failed" >&2
      stale=1
    fi
  fi

  if omp_installed; then
    echo "> Checking oh-my-pi adapter registration"
    rc=0
    bun run "$REPO_ROOT/adapters/omp/reconcile.ts" --check || rc=$?
    if [ "$rc" -eq 3 ]; then
      stale=1
    elif [ "$rc" -ne 0 ]; then
      echo "WARN: omp registration check failed" >&2
      stale=1
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

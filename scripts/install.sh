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
CLAUDE_SETTINGS="$HOME/.claude/settings.json"
PI_SETTINGS="$HOME/.pi/agent/settings.json"
ADAPTER="none"
CHECK_ONLY=0

usage() {
  cat <<EOF
Usage: scripts/install.sh [--adapter none|claudecode|pi] [--check]

Installs the universal echo core as a macOS LaunchAgent.
Adapter registration is optional and runs only after adapter preflight passes.
Every run also re-reconciles all already-installed adapter registrations, so a
repo directory rename heals with one rerun (#77).
--check reports stale echo-related paths across the plist and host settings
without mutating anything. Exit 0 when everything is current, 3 when stale
paths were detected.
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
  none|claudecode|pi) ;;
  *)
    echo "Unknown adapter: $ADAPTER" >&2
    usage >&2
    exit 2
    ;;
esac

is_loaded() {
  launchctl list 2>/dev/null | grep "$1" >/dev/null 2>&1
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

preflight() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required. Install it from https://bun.sh/" >&2
    exit 1
  fi

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
  esac
}

write_plist() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  local tmp_plist="${PLIST_PATH}.tmp.$$"

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
        <string>${REPO_ROOT}/core/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
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

reload_core_service() {
  if is_loaded "$SERVICE_NAME"; then
    echo "> Reloading existing $SERVICE_NAME"
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  fi

  echo "> Loading $SERVICE_NAME"
  launchctl load "$PLIST_PATH"
  sleep 2

  if ! is_loaded "$SERVICE_NAME"; then
    echo "LaunchAgent did not remain loaded: $SERVICE_NAME" >&2
    exit 1
  fi

  for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
    if is_loaded "$legacy"; then
      echo "Legacy service unexpectedly loaded after migration: $legacy" >&2
      exit 1
    fi
  done

  if curl --connect-timeout 2 --max-time 5 -fsS http://localhost:8888/health >/dev/null 2>&1; then
    echo "OK echo is healthy on :8888"
  else
    echo "Voice server did not respond. Check logs: $LOG_PATH" >&2
    exit 1
  fi
}

install_adapter() {
  case "$ADAPTER" in
    claudecode)
      echo "> Installing Claude Code adapter hook registrations"
      bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts"
      ;;
    pi)
      echo "> Installing Pi adapter package"
      pi install "$REPO_ROOT/adapters/pi"
      # pi install appends; reconcile so a stale entry from a renamed clone can't
      # survive beside the fresh one (#77).
      echo "> Reconciling Pi adapter registration"
      bun run "$REPO_ROOT/adapters/pi/reconcile.ts"
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
  fi
  if [ "$ADAPTER" != "pi" ] && pi_installed; then
    echo "> Refreshing Pi adapter registration"
    bun run "$REPO_ROOT/adapters/pi/reconcile.ts" \
      || echo "WARN: Pi registration refresh failed — run adapters/pi/reconcile.ts manually" >&2
  fi
}

check_installation() {
  local stale=0
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
write_plist
migrate_legacy_service
reload_core_service
install_adapter
refresh_installed_adapters

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
ADAPTER="none"

usage() {
  cat <<EOF
Usage: scripts/install.sh [--adapter none|claudecode|pi|omp]

Installs the universal echo core as a macOS LaunchAgent.
Adapter registration is optional and runs only after adapter preflight passes.
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

preflight() {
  if ! command -v bun >/dev/null 2>&1; then
    echo "Bun is required. Install it from https://bun.sh/" >&2
    exit 1
  fi

  case "$ADAPTER" in
    claudecode)
      echo "> Preflighting Claude Code adapter hook registration"
      bun run "$REPO_ROOT/adapters/claudecode/restore-hooks.ts" --check >/dev/null
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
      bun run "$REPO_ROOT/adapters/pi/reconcile-omp.ts" --check >/dev/null || [ $? -eq 3 ]
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
      ;;
    omp)
      echo "> Reconciling oh-my-pi adapter registration"
      bun run "$REPO_ROOT/adapters/pi/reconcile-omp.ts"
      ;;
  esac
}

preflight
write_plist
migrate_legacy_service
reload_core_service
install_adapter

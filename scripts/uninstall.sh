#!/bin/bash
set -euo pipefail
SERVICE_NAME="com.echo"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LOG_PATH="$HOME/Library/Logs/echo.log"
# Versioned daemon payload staged by install.sh (Stage 1) — Echo-owned, so
# uninstall removes it. Logs and the user's persona config are preserved.
PAYLOAD_HOME="$HOME/Library/Application Support/Echo"
ECHO_ENV_FILE="$HOME/.config/echo/.env"
ECHO_PORT="${PORT:-8888}"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ "$CHECK_ONLY" -eq 1 ]; then
  # Read-only: report what a real uninstall would remove; mutate nothing.
  [ -f "$PLIST_PATH" ] && echo "would remove LaunchAgent: $PLIST_PATH" || echo "= no LaunchAgent at $PLIST_PATH"
  [ -d "$PAYLOAD_HOME" ] && echo "would remove payload: $PAYLOAD_HOME" || echo "= no payload at $PAYLOAD_HOME"
  echo "= would preserve logs: $LOG_PATH"
  [ -f "$ECHO_ENV_FILE" ] && echo "= would preserve persona config: $ECHO_ENV_FILE"
  exit 0
fi

if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

rm -f "$PLIST_PATH"
echo "OK removed LaunchAgent $SERVICE_NAME"

if [ -d "$PAYLOAD_HOME" ]; then
  rm -rf "$PAYLOAD_HOME"
  echo "OK removed daemon payload $PAYLOAD_HOME"
fi

if lsof -i :"${ECHO_PORT}" >/dev/null 2>&1; then
  echo "Port ${ECHO_PORT} is still in use; not killing it because it may belong to another service."
fi

echo "Logs preserved at $LOG_PATH"
[ -f "$ECHO_ENV_FILE" ] && echo "Persona config preserved at $ECHO_ENV_FILE"

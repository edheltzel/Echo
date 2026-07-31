#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"
SERVICE_NAME="com.echo"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LOG_PATH="$HOME/Library/Logs/echo.log"
# Versioned daemon payload staged by install.sh (Stage 1) - Echo-owned, so
# uninstall removes it. Its own `payload/` subdir keeps this removal off sibling
# daemon state (mute.json in the same case-insensitive `echo` dir). Logs and the
# user's persona config are preserved.
PAYLOAD_HOME="$HOME/Library/Application Support/echo/payload"
# Honors the documented ECHO_CONFIG_FILE path selector so the preserved-config
# line names the file the daemon actually reads, and never clobbers an exported
# override. Reporting only: this script deletes the LaunchAgent and payload.
CONFIG_FILE="${ECHO_CONFIG_FILE:-$HOME/.config/echo/config.json}"

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ "$CHECK_ONLY" -eq 1 ]; then
  # Read-only: report what a real uninstall would remove; mutate nothing.
  [ -f "$PLIST_PATH" ] && echo "would remove LaunchAgent: $PLIST_PATH" || echo "= no LaunchAgent at $PLIST_PATH"
  [ -d "$PAYLOAD_HOME" ] && echo "would remove payload: $PAYLOAD_HOME" || echo "= no payload at $PAYLOAD_HOME"
  echo "= would preserve logs: $LOG_PATH"
  if [ -f "$CONFIG_FILE" ]; then
    echo "= would preserve persona config: $CONFIG_FILE"
  fi
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
if [ -f "$CONFIG_FILE" ]; then
  echo "Persona config preserved at $CONFIG_FILE"
fi

# A successful uninstall exits 0 regardless of which optional notes were printed.
exit 0

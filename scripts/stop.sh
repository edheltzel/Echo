#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"
SERVICE_NAME="com.echo"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"

if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  echo "OK echo stopped"
else
  echo "echo is not loaded"
fi

if lsof -i :"${ECHO_PORT}" >/dev/null 2>&1; then
  echo "Port ${ECHO_PORT} is still in use; not killing it because it may belong to another service."
fi

#!/bin/bash
set -euo pipefail
SERVICE_NAME="com.echo"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"

if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  echo "OK Echo stopped"
else
  echo "Echo is not loaded"
fi

if lsof -i :8888 >/dev/null 2>&1; then
  echo "Port 8888 is still in use; not killing it because it may belong to another service."
fi

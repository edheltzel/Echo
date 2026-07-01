#!/bin/bash
set -euo pipefail
SERVICE_NAME="com.echo"
PLIST_PATH="$HOME/Library/LaunchAgents/${SERVICE_NAME}.plist"
LOG_PATH="$HOME/Library/Logs/echo.log"

if [ ! -f "$PLIST_PATH" ]; then
  echo "Service not installed. Run scripts/install.sh first." >&2
  exit 1
fi

if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  echo "Voice server is already loaded. Use scripts/restart.sh to restart."
  exit 0
fi

launchctl load "$PLIST_PATH"
sleep 2
if curl --connect-timeout 2 --max-time 5 -fsS http://localhost:8888/health >/dev/null 2>&1; then
  echo "OK Echo started on :8888"
else
  echo "Service loaded but health check failed. Check logs: $LOG_PATH" >&2
  exit 1
fi

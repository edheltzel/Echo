#!/bin/bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"
SERVICE_NAME="com.echo"
# Former labels for this service; warn if any is still loaded after migration.
LEGACY_SERVICE_NAMES=("com.pai.voice-server" "com.atlas.voicesystem")
LOG_PATH="$HOME/Library/Logs/echo.log"

echo "Service: $SERVICE_NAME"
if launchctl list 2>/dev/null | grep "$SERVICE_NAME" >/dev/null 2>&1; then
  launchctl list | grep "$SERVICE_NAME"
else
  echo "not loaded"
fi

for legacy in "${LEGACY_SERVICE_NAMES[@]}"; do
  if launchctl list 2>/dev/null | grep "$legacy" >/dev/null 2>&1; then
    echo "Legacy service still loaded: $legacy"
  fi
done

echo
if curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Health: OK on :${ECHO_PORT}"
  curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL"
  echo
else
  echo "Health: FAIL on :${ECHO_PORT}"
fi

echo "Logs: $LOG_PATH"
[ -f "$LOG_PATH" ] && tail -5 "$LOG_PATH" || true

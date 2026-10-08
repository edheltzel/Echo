#!/bin/bash
# Prove the Pi adapter install path without launching Pi's TUI.
#   bun test tests/adapters/pi
#   bun run adapters/pi/reconcile.ts --check
#   curl GET /health on the configured Echo port
# Exit non-zero on the first failure. Does not POST /notify.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/echo-port.sh
. "$SCRIPT_DIR/echo-port.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cd "$REPO_ROOT"

echo "> Pi unit tests"
bun test tests/adapters/pi

echo "> Pi registration reconcile --check"
rc=0
bun run "$REPO_ROOT/adapters/pi/reconcile.ts" --check || rc=$?
if [ "$rc" -eq 3 ]; then
  fail "Pi registration is stale (reconcile --check exit 3). Run: cli/echo install --adapter pi"
fi
if [ "$rc" -ne 0 ]; then
  fail "Pi reconcile --check exited $rc"
fi

echo "> Echo health on :${ECHO_PORT}"
body="$(curl --connect-timeout 2 --max-time 5 -fsS "$HEALTH_URL")" || fail "Echo is not reachable on :${ECHO_PORT}. Run: cli/echo install --adapter pi"
printf '%s\n' "$body" | grep -q '"status":"healthy"' || fail "Echo /health on :${ECHO_PORT} is not healthy"

echo "OK Pi prove passed"

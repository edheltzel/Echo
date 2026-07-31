#!/bin/bash
# Preflight the binaries required by echo-converse's capture path.
set -euo pipefail

usage() {
  echo "Usage: scripts/converse-dependencies.sh"
  echo "Checks sox/rec, honoring ECHO_CONVERSE_SOX_BIN and ECHO_CONVERSE_REC_BIN."
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

missing=0

check_binary() {
  local label="$1" env_name="$2" default_name="$3" recovery="$4" configured="${!2:-}" resolved=""
  if [ -n "$configured" ]; then
    if [[ "$configured" == */* ]]; then
      [ -x "$configured" ] && resolved="$configured"
    else
      resolved="$(command -v "$configured" 2>/dev/null || true)"
    fi
  else
    resolved="$(command -v "$default_name" 2>/dev/null || true)"
  fi

  if [ -n "$resolved" ]; then
    echo "echo-converse dependency: $label → $resolved"
  else
    echo "Missing echo-converse dependency: $label (${configured:-$default_name})." >&2
    echo "Install it with: $recovery" >&2
    echo "Or set $env_name to an executable override." >&2
    missing=1
  fi
}

# sox is the hard Tier 1 dependency; it provides the rec recorder as well as the
# offline whisper resampler. Keep rec explicit so a split/custom installation is
# diagnosed before the first microphone attempt.
check_binary "sox" ECHO_CONVERSE_SOX_BIN sox "brew install sox"
check_binary "rec" ECHO_CONVERSE_REC_BIN rec "brew install sox"

if [ "$missing" -ne 0 ]; then
  exit 1
fi

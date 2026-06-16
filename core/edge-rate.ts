// Convert a speed multiplier (e.g. 1.08, 0.94) into edge-tts's `--rate`
// percentage string (e.g. "+8%", "-6%"). A speed of exactly 1.0 — or no
// speed at all — means "no per-voice rate", so the global fallback is used.
export function edgeRateFromSpeed(speed?: number, fallbackRate?: string): string {
  if (speed === undefined || speed === 1) {
    return fallbackRate ?? "+0%";
  }
  const pct = Math.round((speed - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

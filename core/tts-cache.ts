// =============================================================================
// TTS synthesis cache — host-neutral
// =============================================================================
// edge-tts is Microsoft's ONLINE service, so every synthesis is a network
// round-trip whose fixed overhead (python spawn + `import edge_tts` + WebSocket
// handshake) dominates startup latency — a ~14-char catchphrase pays the same
// 2–8 s as a long line. But the startup catchphrase is drawn from a small FIXED
// pool, and edge-tts output for identical (voice, rate, text) is deterministic.
// So short, repeated phrases are cached to disk and replayed straight from the
// file — turning an 8 s network synth into a ~tens-of-ms disk read.
//
// Only SHORT phrases are cached: long, unique completion summaries would never
// hit and would grow the cache without bound. All writes are best-effort — a
// cache failure must never break /notify.

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { parseBoundedInt } from "./env";

// Texts longer than this bypass the cache entirely (catchphrases / "standing
// by" lines are well under it). Canonical ECHO_* read first; legacy
// VOICESYSTEM_* kept as a silent fallback, matching the rest of core/.
export const TTS_CACHE_MAX_TEXT_CHARS = parseBoundedInt(
  process.env.ECHO_TTS_CACHE_MAX_TEXT_CHARS ?? process.env.VOICESYSTEM_TTS_CACHE_MAX_TEXT_CHARS,
  80,
  1,
);

// Total cache-size cap; oldest-by-mtime files are pruned first. ~20 MB default
// (floor 64 KB) — thousands of short clips.
export const TTS_CACHE_MAX_BYTES = parseBoundedInt(
  process.env.ECHO_TTS_CACHE_MAX_BYTES ?? process.env.VOICESYSTEM_TTS_CACHE_MAX_BYTES,
  20_000_000,
  65_536,
);

// User-owned cache path (macOS ~/Library/Caches, else $XDG_CACHE_HOME /
// ~/.cache), never /tmp, never the repo. Override with ECHO_TTS_CACHE_DIR.
// Resolved at call time (not frozen at import) so a test setting the override
// before its first call writes to the intended path regardless of import order.
export function ttsCacheDir(): string {
  const override = process.env.ECHO_TTS_CACHE_DIR ?? process.env.VOICESYSTEM_TTS_CACHE_DIR;
  if (override) return override;
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "echo", "tts-cache")
    : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "echo", "tts-cache");
}

// A phrase is cacheable when it's short enough to be a recurring line.
export function isCacheableText(text: string): boolean {
  return text.length > 0 && text.length <= TTS_CACHE_MAX_TEXT_CHARS;
}

// Key on the EXACT synthesis inputs — voice + rate + the already-pronunciation-
// processed text — so any change (voice swap, rate change) misses and
// re-synthesizes rather than replaying a stale clip.
export function ttsCacheKey(voice: string, rate: string, processedText: string): string {
  return createHash("sha256").update(`${voice}\n${rate}\n${processedText}`).digest("hex");
}

export function ttsCachePath(
  voice: string,
  rate: string,
  processedText: string,
  dir: string = ttsCacheDir(),
): string {
  return join(dir, `${ttsCacheKey(voice, rate, processedText)}.mp3`);
}

// Return the cached mp3 path when a non-empty hit exists for cacheable text,
// else null. On a hit, bump mtime so LRU pruning keeps recently-used entries.
export function readTtsCache(
  voice: string,
  rate: string,
  processedText: string,
  dir: string = ttsCacheDir(),
): string | null {
  if (!isCacheableText(processedText)) return null;
  const path = ttsCachePath(voice, rate, processedText, dir);
  try {
    if (statSync(path).size > 0) {
      const now = new Date();
      try { utimesSync(path, now, now); } catch { /* touch is best-effort */ }
      return path;
    }
  } catch { /* miss */ }
  return null;
}

// Copy a freshly-synthesized mp3 into the cache (atomic rename via a temp file).
// No-op for non-cacheable text. Best-effort — swallows all errors.
export function writeTtsCache(
  voice: string,
  rate: string,
  processedText: string,
  srcFile: string,
  dir: string = ttsCacheDir(),
): void {
  if (!isCacheableText(processedText)) return;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const dest = ttsCachePath(voice, rate, processedText, dir);
    const tmp = `${dest}.${process.pid}.tmp`;
    copyFileSync(srcFile, tmp);
    renameSync(tmp, dest);
    pruneTtsCache(dir, TTS_CACHE_MAX_BYTES);
  } catch { /* swallow — cache write must never break a notification */ }
}

// Drop oldest-by-mtime files until total size fits the cap. Best-effort.
export function pruneTtsCache(
  dir: string = ttsCacheDir(),
  maxBytes: number = TTS_CACHE_MAX_BYTES,
): void {
  try {
    const entries = readdirSync(dir)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => {
        const p = join(dir, f);
        const s = statSync(p);
        return { p, size: s.size, mtime: s.mtimeMs };
      });
    let total = entries.reduce((a, e) => a + e.size, 0);
    if (total <= maxBytes) return;
    entries.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const e of entries) {
      if (total <= maxBytes) break;
      try { unlinkSync(e.p); total -= e.size; } catch { /* skip */ }
    }
  } catch { /* swallow */ }
}

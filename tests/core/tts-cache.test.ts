// TTS synthesis cache (#202 catchphrase pre-cache): short repeated phrases are
// stored to disk keyed by (voice, rate, processed text) and replayed straight
// from the file, skipping edge-tts's network synthesis. Long unique lines
// bypass the cache; the cache is size-capped with oldest-first pruning.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCacheableText,
  pruneTtsCache,
  readTtsCache,
  ttsCacheKey,
  ttsCacheDir,
  writeTtsCache,
  TTS_CACHE_MAX_TEXT_CHARS,
} from "../../core/tts-cache";
import { primeEchoFileEnv } from "../../core/env";

let dir: string;
let srcDir: string;
const VOICE = "en-GB-RyanNeural";
const RATE = "-8%";

// Make a throwaway mp3-ish source file to copy into the cache. Written to a
// SEPARATE dir so source files never pollute the cache dir's size accounting.
function makeSrc(bytes = 1024): string {
  const p = join(srcDir, `src-${Math.random().toString(36).slice(2)}.mp3`);
  writeFileSync(p, Buffer.alloc(bytes, 1));
  return p;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "echo-tts-cache-"));
  srcDir = mkdtempSync(join(tmpdir(), "echo-tts-src-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
  delete process.env.ECHO_TTS_CACHE_DIR;
});

describe("ttsCacheKey", () => {
  test("is deterministic and sensitive to every input", () => {
    const base = ttsCacheKey(VOICE, RATE, "Atlas, standing by");
    expect(ttsCacheKey(VOICE, RATE, "Atlas, standing by")).toBe(base);
    expect(ttsCacheKey("en-US-AvaNeural", RATE, "Atlas, standing by")).not.toBe(base);
    expect(ttsCacheKey(VOICE, "+0%", "Atlas, standing by")).not.toBe(base);
    expect(ttsCacheKey(VOICE, RATE, "Atlas online")).not.toBe(base);
  });
});

describe("isCacheableText", () => {
  test("accepts short non-empty phrases, rejects empty and over-long", () => {
    expect(isCacheableText("Atlas, standing by")).toBe(true);
    expect(isCacheableText("")).toBe(false);
    expect(isCacheableText("x".repeat(TTS_CACHE_MAX_TEXT_CHARS))).toBe(true);
    expect(isCacheableText("x".repeat(TTS_CACHE_MAX_TEXT_CHARS + 1))).toBe(false);
  });
});

describe("write / read round-trip", () => {
  test("write then read returns the cached path", () => {
    const src = makeSrc();
    expect(readTtsCache(VOICE, RATE, "Atlas, standing by", dir)).toBeNull();
    writeTtsCache(VOICE, RATE, "Atlas, standing by", src, dir);
    const hit = readTtsCache(VOICE, RATE, "Atlas, standing by", dir);
    expect(hit).not.toBeNull();
    expect(existsSync(hit!)).toBe(true);
  });

  test("miss returns null for an uncached phrase", () => {
    expect(readTtsCache(VOICE, RATE, "never synthesized", dir)).toBeNull();
  });

  test("over-long text is not cached and never hits", () => {
    const long = "y".repeat(TTS_CACHE_MAX_TEXT_CHARS + 5);
    const src = makeSrc();
    writeTtsCache(VOICE, RATE, long, src, dir);
    expect(readTtsCache(VOICE, RATE, long, dir)).toBeNull();
  });
});

describe("pruneTtsCache", () => {
  test("drops oldest-by-mtime files until under the cap", () => {
    // Three 1 KB entries; cap at 2 KB should leave the 2 newest.
    const phrases = ["one", "two", "three"];
    phrases.forEach((p, i) => {
      writeTtsCache(VOICE, RATE, p, makeSrc(1024), dir);
      // stagger mtimes so "oldest" is deterministic
      const path = readTtsCache(VOICE, RATE, p, dir)!;
      const t = new Date(Date.now() - (phrases.length - i) * 60_000);
      utimesSync(path, t, t);
    });
    pruneTtsCache(dir, 2048);
    // "one" is oldest → evicted; "two"/"three" survive.
    expect(readTtsCache(VOICE, RATE, "one", dir)).toBeNull();
    expect(readTtsCache(VOICE, RATE, "two", dir)).not.toBeNull();
    expect(readTtsCache(VOICE, RATE, "three", dir)).not.toBeNull();
  });
});

describe("ECHO_TTS_CACHE_DIR override", () => {
  test("env-file override is honored when live env is absent", () => {
    const saved = process.env.ECHO_TTS_CACHE_DIR;
    try {
      delete process.env.ECHO_TTS_CACHE_DIR;
      primeEchoFileEnv({ ECHO_TTS_CACHE_DIR: "/from/file" });
      expect(ttsCacheDir()).toBe("/from/file");
    } finally {
      if (saved === undefined) delete process.env.ECHO_TTS_CACHE_DIR;
      else process.env.ECHO_TTS_CACHE_DIR = saved;
      primeEchoFileEnv(undefined);
    }
  });

  test("ttsCacheDir honors the env override", () => {
    process.env.ECHO_TTS_CACHE_DIR = dir;
    expect(ttsCacheDir()).toBe(dir);
  });
});

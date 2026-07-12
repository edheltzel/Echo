#!/usr/bin/env bun
/**
 * precache-catchphrases.ts — pre-warm the TTS cache for short, repeated phrases.
 *
 * edge-tts is Microsoft's ONLINE service, so a cold startup catchphrase pays a
 * 2–8 s network synth. The daemon caches short phrases after first use, but that
 * still leaves the FIRST session after a voice/phrase change slow. This script
 * warms the cache up front by POSTing each phrase to the RUNNING daemon exactly
 * as the greeting hook does (no voice_id → identity voice), so the daemon
 * computes the SAME cache key it will read at startup — no key-matching logic
 * here, and pronunciations/voice/rate stay authoritative in one place (the
 * daemon). Each phrase is spoken once while warming (a one-time setup cost).
 *
 * Re-run after any change to the catchphrase pool or the identity voice/rate.
 *
 * Usage:
 *   bun scripts/precache-catchphrases.ts "Atlas, standing by" "Atlas online"
 *   bun scripts/precache-catchphrases.ts --settings ~/.claude/settings.json
 *   ECHO_NOTIFY_URL=http://localhost:8888/notify bun scripts/precache-catchphrases.ts ...
 */

const args = process.argv.slice(2);
const ECHO_URL = process.env.ECHO_NOTIFY_URL ?? "http://localhost:8888/notify";

// Mirror the hook's catchphrase extraction: single `startupCatchphrase` plus the
// `startupCatchphrases` pool, `{name}` expanded to the DA display name.
async function phrasesFromSettings(path: string): Promise<string[]> {
  const s = await Bun.file(path).json();
  const id = s.daidentity ?? {};
  const name = id.displayName || id.name || "Atlas";
  return [id.startupCatchphrase, ...(Array.isArray(id.startupCatchphrases) ? id.startupCatchphrases : [])]
    .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    .map((p) => p.replace(/\{name\}/gi, name));
}

const settingsIdx = args.indexOf("--settings");
const phrases = settingsIdx !== -1
  ? await phrasesFromSettings(args[settingsIdx + 1])
  : args.filter((a) => !a.startsWith("--"));

if (phrases.length === 0) {
  console.error("No phrases to pre-cache. Pass phrases as args or --settings <path>.");
  process.exit(1);
}

console.log(`Pre-caching ${phrases.length} phrase(s) via ${ECHO_URL} …`);
for (const message of phrases) {
  try {
    const res = await fetch(ECHO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, title: "Pre-cache", source: "precache" }),
    });
    console.log(`  ${res.status} — "${message}"`);
  } catch (err) {
    console.error(`  FAILED — "${message}": ${err instanceof Error ? err.message : err}`);
  }
}
console.log("Queued. The daemon synthesizes + caches each phrase as it plays (serial queue).");
console.log("After it finishes speaking, the cache is warm and startup greetings play instantly.");

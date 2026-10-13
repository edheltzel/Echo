#!/usr/bin/env bun
/**
 * Pre-warm explicitly supplied phrases in the daemon's default voice.
 * Each phrase is spoken once; run only when that audible setup is wanted.
 * Usage: bun scripts/precache-catchphrases.ts "Open code, ready."
 */

import { loadEchoConfiguration } from "../shared/echo-env.ts";

const phrases = process.argv.slice(2);
if (phrases.length === 0 || phrases.some((phrase) => phrase.startsWith("--"))) {
  console.error("Pass spoken phrases as arguments; settings-based startup pools are no longer supported.");
  process.exit(2);
}
const ECHO_URL = loadEchoConfiguration().ECHO_NOTIFY_URL ?? "http://localhost:3246/notify";

console.log(`Pre-caching ${phrases.length} phrase(s) via ${ECHO_URL} …`);
for (const message of phrases) {
  try {
    const res = await fetch(ECHO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, title: "Pre-cache", source: "precache" }),
    });
    console.log(`  ${res.status} - "${message}"`);
  } catch (err) {
    console.error(`  FAILED - "${message}": ${err instanceof Error ? err.message : err}`);
  }
}
console.log("Queued. The daemon synthesizes + caches each phrase as it plays (serial queue).");
console.log("Short phrases are cached for the daemon's default voice.");

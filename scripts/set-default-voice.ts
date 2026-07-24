#!/usr/bin/env bun
// `echo voice <name> <voice-id>` — set the default Echo persona (name + edge-tts
// voice) for pi and omp agent sessions by merge-writing ~/.config/echo/.env, the
// first env file the daemon and adapters read (shared/echo-env.ts). The two keys
// are the ones adapters resolve for the spoken persona name + voice id.
//
// Claude Code reads its persona from ~/.claude/settings.json (adapters/…/identity.ts),
// not these env vars, so this command is scoped to pi/omp; the confirmation says so.
//
// Validation reuses looksLikeEdgeVoice so the edge-tts grammar stays single-sourced.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { looksLikeEdgeVoice } from "../shared/edge-voice";

const ENV_FILE = process.env.ECHO_ENV_FILE ?? join(homedir(), ".config", "echo", ".env");
const NAME_KEY = "ECHO_VOICE_PERSONA_NAME";
const VOICE_KEY = "ECHO_VOICE_ID";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [name, voice] = process.argv.slice(2);
if (!name || !voice) {
  fail("Usage: echo voice <name> <edge-tts-voice-id>   e.g. echo voice Echo en-US-AndrewNeural");
}
if (!looksLikeEdgeVoice(voice)) {
  console.error(`"${voice}" doesn't look like an edge-tts voice (e.g. en-US-AndrewNeural).`);
  fail("List available voices: bun scripts/preview-voices.ts --list");
}

// Merge-preserving write: keep every existing line except assignments of the two
// keys we own; comments, blanks, and unrelated keys survive. Then append the
// canonical pair. A malformed line is never parsed — it is simply preserved.
const raw = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
const ownedRe = new RegExp(`^\\s*(${NAME_KEY}|${VOICE_KEY})\\s*=`);
const kept = raw.split("\n").filter((line) => !ownedRe.test(line));
while (kept.length && kept[kept.length - 1].trim() === "") kept.pop();

const next = [...kept, `${NAME_KEY}="${name}"`, `${VOICE_KEY}="${voice}"`].join("\n") + "\n";

mkdirSync(dirname(ENV_FILE), { recursive: true });
// One-shot backup of any prior file, then atomic replace.
if (existsSync(ENV_FILE)) writeFileSync(`${ENV_FILE}.bak`, raw);
const tmp = `${ENV_FILE}.tmp.${process.pid}`;
writeFileSync(tmp, next);
renameSync(tmp, ENV_FILE);

console.log(`Set default persona "${name}" (${voice}) in ${ENV_FILE}.`);
console.log("Applies to pi and omp sessions. Claude Code reads its persona from");
console.log("~/.claude/settings.json — set it there or with the /echo-voice command.");
console.log("Start a new agent session to hear it.");

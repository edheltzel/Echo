#!/usr/bin/env bun
// `echo voice <name> <voice-id>` - set the default Echo persona (name + edge-tts
// voice) in ~/.config/echo/config.json for pi and omp agent sessions. Claude Code
// reads its persona from ~/.claude/settings.json instead.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { echoConfigPath } from "../shared/echo-env";
import { looksLikeEdgeVoice } from "../shared/edge-voice";

// One resolver for reader and writer, so `echo voice` can never report success
// after writing to a file the daemon does not read.
const CONFIG_FILE = echoConfigPath(process.env.HOME ?? homedir(), process.env);
const NAME_KEY = "ECHO_VOICE_PERSONA_NAME";
const VOICE_KEY = "ECHO_VOICE_ID";
const ILLEGAL_IN_NAME = /[\u0000-\u001f\u007f"]/;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [name, voice] = process.argv.slice(2);
if (!name || !voice) fail("Usage: echo voice <name> <edge-tts-voice-id>   e.g. echo voice Echo en-US-AndrewNeural");
if (ILLEGAL_IN_NAME.test(name)) {
  fail(`Persona name must not contain control characters or double quotes: ${JSON.stringify(name)}`);
}
if (!looksLikeEdgeVoice(voice)) {
  console.error(`"${voice}" doesn't look like an edge-tts voice (e.g. en-US-AndrewNeural).`);
  fail("List available voices: bun scripts/preview-voices.ts --list");
}

const raw = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : "{}";
let config: Record<string, unknown>;
try {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  config = parsed as Record<string, unknown>;
} catch {
  fail(`Cannot update invalid JSON configuration: ${CONFIG_FILE}`);
}

config[NAME_KEY] = name;
config[VOICE_KEY] = voice;
const next = JSON.stringify(config, null, 2) + "\n";

mkdirSync(dirname(CONFIG_FILE), { recursive: true });
if (existsSync(CONFIG_FILE)) writeFileSync(`${CONFIG_FILE}.bak`, raw);
const tmp = `${CONFIG_FILE}.tmp.${process.pid}`;
writeFileSync(tmp, next);
renameSync(tmp, CONFIG_FILE);

console.log(`Set default persona "${name}" (${voice}) in ${CONFIG_FILE}.`);
console.log("Applies to pi and omp sessions. Claude Code reads its persona from");
console.log("~/.claude/settings.json - set it there or with the /echo-voice command.");
console.log("Start a new agent session to hear it.");

#!/usr/bin/env bun
// `echo voice <name> <voice-id>` - set the default Echo persona (name + edge-tts
// voice) in ~/.config/echo/config.json for pi and omp agent sessions. Claude Code
// reads its persona from ~/.claude/settings.json instead. Interactive runs also
// ask whether subagents may speak; the safe default is no.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { echoConfigPath, parseEchoBoolean } from "../shared/echo-env";
import { looksLikeEdgeVoice } from "../shared/edge-voice";

// One resolver for reader and writer, so `echo voice` can never report success
// after writing to a file the daemon does not read.
const CONFIG_FILE = echoConfigPath(process.env.HOME ?? homedir(), process.env);
const NAME_KEY = "ECHO_VOICE_PERSONA_NAME";
const VOICE_KEY = "ECHO_VOICE_ID";
const SUPPRESS_SUBAGENTS_KEY = "ECHO_VOICE_SUPPRESS_SUBAGENTS";
const ILLEGAL_IN_NAME = /[\u0000-\u001f\u007f"]/;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(args: string[]): { name?: string; voice?: string; allowSubagents?: boolean } {
  const positional: string[] = [];
  let allowSubagents: boolean | undefined;
  for (const arg of args) {
    if (arg === "--allow-subagents") {
      if (allowSubagents === false) fail("Choose only one of --allow-subagents and --suppress-subagents.");
      allowSubagents = true;
    } else if (arg === "--suppress-subagents") {
      if (allowSubagents === true) fail("Choose only one of --allow-subagents and --suppress-subagents.");
      allowSubagents = false;
    } else if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { name: positional[0], voice: positional[1], allowSubagents };
}

async function askForSubagentVoice(): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Enable voice for subagents? [y/N] ");
    return parseEchoBoolean(answer, false);
  } finally {
    prompt.close();
  }
}

async function main(): Promise<void> {
  const { name, voice, allowSubagents: explicitPreference } = parseArgs(process.argv.slice(2));
  if (!name || !voice) {
    fail(
      "Usage: echo voice <name> <edge-tts-voice-id> [--allow-subagents|--suppress-subagents] " +
        " e.g. echo voice Echo en-US-AndrewNeural",
    );
  }
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

  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const allowSubagents = explicitPreference
    ?? (interactive
      ? await askForSubagentVoice()
      : config[SUPPRESS_SUBAGENTS_KEY] === undefined
        ? false
        : !parseEchoBoolean(config[SUPPRESS_SUBAGENTS_KEY], true));

  config[NAME_KEY] = name;
  config[VOICE_KEY] = voice;
  // A missing preference is written as true in the non-interactive path too,
  // making the default visible and keeping VoiceGate fail-closed for upgrades.
  if (explicitPreference !== undefined || interactive || config[SUPPRESS_SUBAGENTS_KEY] === undefined) {
    config[SUPPRESS_SUBAGENTS_KEY] = !allowSubagents;
  }
  const next = JSON.stringify(config, null, 2) + "\n";

  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  if (existsSync(CONFIG_FILE)) writeFileSync(`${CONFIG_FILE}.bak`, raw);
  const tmp = `${CONFIG_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, CONFIG_FILE);

  console.log(`Set default persona "${name}" (${voice}) in ${CONFIG_FILE}.`);
  console.log(`Subagent voice: ${allowSubagents ? "enabled" : "disabled (default)"}.`);
  console.log("Applies to pi and omp sessions. Claude Code reads its persona from");
  console.log("~/.claude/settings.json - set it there or with the /echo-voice command.");
  console.log("Start a new agent session to hear it.");
}

await main();

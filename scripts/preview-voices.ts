#!/usr/bin/env bun
// Audition the available English edge-tts voices so per-persona voice/rate
// choices in core/voices.json can be made by ear. Dev tooling only - not on
// the runtime request path. Usage: `scripts/preview-voices.ts --help`.

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { loadEchoConfiguration } from "../shared/echo-env.ts";

const ECHO_CONFIG = loadEchoConfiguration();
const PYTHON3_PATH = ECHO_CONFIG.ECHO_PYTHON3_PATH || ECHO_CONFIG.PYTHON3_PATH || "/opt/homebrew/bin/python3";
const DEFAULT_LOCALES = ["en-US", "en-GB", "en-AU", "en-IE"];
const DEFAULT_TEXT = "Hi, I'm {voice}. This is how I sound for Atlas.";
const CACHE_DIR =
  ECHO_CONFIG.ECHO_AUDIO_CACHE_DIR ??
  (process.platform === "darwin"
    ? join(homedir(), "Library", "Caches", "echo", "audio")
    : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "echo", "audio"));

export interface EdgeVoice {
  name: string;
  gender: string;
}

// Parse `edge-tts --list-voices` table output into {name, gender}[].
export function parseVoiceList(raw: string): EdgeVoice[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Name") && !line.startsWith("---"))
    .map((line) => {
      const cols = line.split(/\s+/);
      return { name: cols[0], gender: cols[1] ?? "" };
    })
    .filter((v) => v.name);
}

// Keep only voices whose name belongs to one of the given locale prefixes.
export function filterByLocale(voices: EdgeVoice[], locales: string[]): EdgeVoice[] {
  return voices.filter((v) => locales.some((loc) => v.name.startsWith(loc + "-")));
}

// Build the `edge_tts` argv for one sample synthesis.
export function buildSynthArgs(voice: string, text: string, rate: string, outFile: string): string[] {
  return [
    "-m",
    "edge_tts",
    "--text",
    text.replaceAll("{voice}", voice),
    "--voice",
    voice,
    "--rate",
    rate,
    "--write-media",
    outFile,
  ];
}

export const USAGE = `Usage: scripts/preview-voices.ts [options]

Audition English edge-tts voices so you can pick per-persona voices for
core/voices.json by ear. --list and --dry-run play no audio.

Options:
  --locale <a,b>   Comma-separated locale prefixes to audition (default: ${DEFAULT_LOCALES.join(",")})
  --voices <a,b>   Explicit voice ids; overrides --locale
  --text <line>    Sample line; {voice} is replaced with the voice id
                   (default: "${DEFAULT_TEXT}")
  --rate <rate>    edge-tts rate for every sample (default: +0%)
  --list           Print the matched voices, no audio
  --dry-run        Print the matched voices and synth command, no audio
  -h, --help       Show this help and exit

Examples:
  scripts/preview-voices.ts --list
  scripts/preview-voices.ts --locale en-GB
  scripts/preview-voices.ts --voices en-GB-RyanNeural,en-GB-ThomasNeural
  scripts/preview-voices.ts --voices en-GB-ThomasNeural --rate -6%
  scripts/preview-voices.ts --dry-run --voices en-GB-RyanNeural
`;

interface Options {
  locales: string[];
  voices: string[] | null;
  text: string;
  rate: string;
  list: boolean;
  dryRun: boolean;
  help: boolean;
}

/** Throws on an unknown argument or a flag missing its value. */
export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    locales: DEFAULT_LOCALES,
    voices: null,
    text: DEFAULT_TEXT,
    rate: "+0%",
    list: false,
    dryRun: false,
    help: false,
  };
  const value = (i: number, flag: string): string => {
    const v = argv[i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    return v;
  };
  const csv = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") opts.list = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--locale") opts.locales = csv(value(++i, arg));
    else if (arg === "--voices") opts.voices = csv(value(++i, arg));
    else if (arg === "--text") opts.text = value(++i, arg);
    else if (arg === "--rate") opts.rate = value(++i, arg);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

type SpawnEvents = {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "exit", listener: (code: number | null) => void): void;
};

function spawnEvents(proc: ReturnType<typeof spawn>): SpawnEvents {
  return proc as unknown as SpawnEvents;
}

function listVoicesRaw(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON3_PATH, ["-m", "edge_tts", "--list-voices"]);
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    const events = spawnEvents(proc);
    events.on("error", reject);
    events.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`edge-tts --list-voices exited ${code}`))));
  });
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    const events = spawnEvents(proc);
    events.on("error", reject);
    events.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`preview-voices: ${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }

  // Resolve the target voice set.
  let voices: EdgeVoice[];
  if (opts.voices && opts.voices.length > 0) {
    voices = opts.voices.map((name) => ({ name, gender: "" }));
  } else {
    voices = filterByLocale(parseVoiceList(await listVoicesRaw()), opts.locales);
  }

  if (voices.length === 0) {
    console.error(`No voices matched (locales: ${opts.locales.join(", ")}).`);
    return 1;
  }

  if (opts.list || opts.dryRun) {
    for (const v of voices) {
      const meta = v.gender ? `  ${v.gender}` : "";
      console.log(`${v.name}${meta}`);
      if (opts.dryRun) {
        console.log(`  synth: ${PYTHON3_PATH} ${buildSynthArgs(v.name, opts.text, opts.rate, "<tmp>.mp3").join(" ")}`);
      }
    }
    return 0;
  }

  const player = process.platform === "darwin" ? "/usr/bin/afplay" : "mpv";
  mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  for (const v of voices) {
    const dir = mkdtempSync(join(CACHE_DIR, "preview-"));
    const file = join(dir, "sample.mp3");
    try {
      console.log(`🔊 ${v.name} (rate ${opts.rate})`);
      const synthCode = await run(PYTHON3_PATH, buildSynthArgs(v.name, opts.text, opts.rate, file));
      if (synthCode !== 0) {
        console.error(`  ✗ synthesis failed for ${v.name}`);
        continue;
      }
      await run(player, [file]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return 0;
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}

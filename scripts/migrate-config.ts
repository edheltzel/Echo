#!/usr/bin/env bun
// Move legacy dotenv Echo settings into ~/.config/echo/config.json.
//
// Run by scripts/install.sh before the port preflight, so an existing dotenv
// PORT is in config.json by the time the CLI, the lifecycle scripts and the
// daemon each resolve one. Non-destructive in both directions: a key already in
// config.json is never overwritten, and the dotenv file is never edited or
// removed — it stays the permanent home of ELEVENLABS_API_KEY, the one secret
// config.json rejects.
//
// Idempotent: a second run finds every migratable key already present and
// reports nothing. Never fails the install — an unusable config.json is
// reported and left alone.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ECHO_CONFIG_KEYS,
  echoConfigPath,
  legacyEchoEnvPaths,
  parseDotenvFile,
} from "../shared/echo-env";

const SECRET_KEY = "ELEVENLABS_API_KEY";

const home = process.env.HOME ?? homedir();
const configFile = echoConfigPath(home, process.env);
const legacyPaths = legacyEchoEnvPaths(home).filter((path) => existsSync(path));

// Echo no longer reads PORT from any dotenv file, and these two locations are
// not drained: ECHO_ENV_PATHS is a caller-supplied selector, and ~/.env is a
// shared user dotfile that is not Echo's to rewrite. A PORT sitting in one of
// them would move the daemon to 3246 silently, so name it on every run until it
// is acted on.
for (const path of [
  ...(process.env.ECHO_ENV_PATHS?.split(":").filter(Boolean) ?? []),
  join(home, ".env"),
]) {
  const port = parseDotenvFile(path).PORT;
  if (port === undefined) continue;
  console.log(`> PORT=${port} in ${path} is no longer honored — Echo reads PORT from config.json only.`);
  console.log(`  That file is not migrated automatically. Add "PORT": ${port} to ${configFile}`);
  console.log("  to keep it, or remove the line to accept the default 3246.");
}

if (legacyPaths.length === 0) process.exit(0);

// First file wins per key, matching the daemon's dotenv precedence. The winning
// file is tracked per key so a report can name the file the value actually came
// from — telling a user to keep the wrong one is how the secret gets deleted.
const legacy: Record<string, { value: string; source: string }> = {};
for (const path of legacyPaths) {
  for (const [key, value] of Object.entries(parseDotenvFile(path))) {
    if (legacy[key] === undefined) legacy[key] = { value, source: path };
  }
}

// Every filesystem step below is fault-tolerant: install.sh runs this inside
// preflight under `set -euo pipefail`, so an unreadable config.json or a
// read-only config dir must report and step aside, not abort the install with a
// stack trace.
function readRawConfig(): string | null {
  if (!existsSync(configFile)) return "{}";
  try {
    return readFileSync(configFile, "utf8");
  } catch {
    return null;
  }
}

function parseConfigObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function skip(reason: string): never {
  console.error(`> Skipping config migration: ${configFile} ${reason}. Fix it and rerun the installer.`);
  process.exit(0);
}

const raw = readRawConfig();
if (raw === null) skip("exists but could not be read");

const existing = parseConfigObject(raw ?? "{}");
if (existing === null) skip("is not a JSON object");
const config: Record<string, unknown> = existing ?? {};

// Only canonical Echo keys move. That drops the retired VOICESYSTEM_* aliases,
// the host-owned variables, and the secret — writing any of them would produce a
// config.json the daemon's own validation rejects.
//
// PORT is written trimmed: a dotenv `PORT=" 8888 "` keeps its padding through
// quote stripping, and the JSON port grammar accepts no surrounding whitespace,
// so migrating it verbatim would silently drop the port the user had.
const migrated: string[] = [];
for (const [key, entry] of Object.entries(legacy)) {
  if (!ECHO_CONFIG_KEYS.has(key)) continue;
  if (config[key] !== undefined) continue;
  config[key] = key === "PORT" ? entry.value.trim() : entry.value;
  migrated.push(key);
}

// Nothing moved means an already-migrated install: stay silent rather than
// reprinting the same report on every reinstall.
if (migrated.length === 0) process.exit(0);

try {
  mkdirSync(dirname(configFile), { recursive: true });
  if (existsSync(configFile)) writeFileSync(`${configFile}.bak`, raw ?? "{}");
  const tmp = `${configFile}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n");
  renameSync(tmp, configFile);
} catch {
  skip("could not be written");
}

console.log(`> Migrated ${migrated.length} setting(s) into ${configFile}: ${migrated.sort().join(", ")}`);
console.log(`  Source: ${legacyPaths.join(", ")} (left in place, unchanged)`);

// Said at the one moment the user might otherwise "finish" the migration by
// deleting the file the daemon still reads the key from — so it has to name the
// file that actually holds it, not just the first location searched.
const secret = legacy[SECRET_KEY];
if (secret !== undefined) {
  console.log(`> ${SECRET_KEY} stays in ${secret.source} — it is a secret and config.json rejects it.`);
  console.log("  Do not delete that file: it is where the daemon reads the key from.");
}

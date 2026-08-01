import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type EchoEnvironment = Record<string, string | undefined>;
export type EchoConfigValue = string | number | boolean;

export const ECHO_CONFIG_PATH_PARTS = [".config", "echo", "config.json"] as const;

// Keep this list in lockstep with shared/config-schema.json. The schema is the
// durable format contract; this set prevents an accidental secret or host-owned
// setting from being treated as Echo configuration at runtime.
export const ECHO_CONFIG_KEYS = new Set([
  "PORT", "VOICES_PATH", "PRONUNCIATIONS_PATH",
  "ECHO_VOICE_PERSONA_NAME", "ECHO_VOICE_ID", "ECHO_VOICE_TITLE", "ECHO_PYTHON3_PATH",
  "ECHO_VOICE_CATCHPHRASE", "ECHO_VOICE_ENABLED", "ECHO_VOICE_GREET_ON_START",
  "ECHO_VOICE_SPEAK_COMPLETIONS", "ECHO_VOICE_SUPPRESS", "ECHO_VOICE_SUPPRESS_SUBAGENTS",
  "ECHO_DEFAULT_TITLE",
  "ECHO_EDGETTS_TIMEOUT_MS", "ECHO_EDGETTS_TIMEOUT_MAX_MS", "ECHO_EDGETTS_TIMEOUT_PER_CHAR_MS",
  "ECHO_EDGETTS_HEALTH_TIMEOUT_MS", "ECHO_EDGETTS_SYNTH_RETRIES", "ECHO_EDGETTS_SYNTH_BACKOFF_MS",
  "ECHO_CIRCUIT_BREAKER_THRESHOLD", "ECHO_PLAY_QUEUE_MAX_DEPTH", "ECHO_PLAY_QUEUE_AGE_CAP_MS",
  "ECHO_PLAY_QUEUE_PLAYER_TIMEOUT_MS", "ECHO_AUDIO_PROCESS_TIMEOUT_MS",
  "ECHO_NOTIFICATION_PROCESS_TIMEOUT_MS", "ECHO_TTS_CACHE_DIR", "ECHO_TTS_CACHE_MAX_BYTES",
  "ECHO_TTS_CACHE_MAX_TEXT_CHARS", "ECHO_AUDIO_CACHE_DIR", "ECHO_MUTE_STATE_PATH",
  "ECHO_CAPTURE_STATE_PATH", "ECHO_AUDIO_LIFECYCLE_LOG", "ECHO_AUDIO_LIFECYCLE_LOG_MAX_BYTES",
  "ECHO_RESOLUTION_LOG", "ECHO_RESOLUTION_LOG_MAX_BYTES", "ECHO_VOICE_EVENTS_LOG",
  "ECHO_DAEMON_URL", "ECHO_NOTIFY_URL", "ECHO_VOICE_SURFACES",
  // The macOS fallback speaker, so the last rung of the provider chain can be
  // pointed at a wrapper instead of /usr/bin/say.
  "ECHO_SAY_BIN",
  // echo-converse (one-shot voice ask). Only the coordinator reads PORT/URL and
  // the booking lock; the rest are read in the calling host's process, where the
  // capture actually happens.
  "ECHO_CONVERSE_PORT", "ECHO_CONVERSE_URL", "ECHO_CONVERSE_BOOKING_LOCK",
  "ECHO_CONVERSE_LEASE_MS", "ECHO_CONVERSE_LOG_PATH", "ECHO_CONVERSE_CAPTURE_DIR", "ECHO_CONVERSE_MAX_CAPTURE_MS",
  "ECHO_CONVERSE_SILENCE_MS", "ECHO_CONVERSE_TRANSCRIBE_TIMEOUT_MS",
  "ECHO_CONVERSE_LOCALE", "ECHO_CONVERSE_STT_TIER",
  "ECHO_CONVERSE_REC_BIN", "ECHO_CONVERSE_SOX_BIN", "ECHO_CONVERSE_YAP_BIN",
  "ECHO_CONVERSE_WHISPER_BIN", "ECHO_CONVERSE_WHISPER_MODEL",
]);

export const DEPRECATED_ENV_ALIASES = new Set([
  "ATLAS_VOICE_NOTIFY_URL", "ATLAS_VOICE_ID", "ATLAS_VOICE_TITLE",
  "ATLAS_VOICE_CATCHPHRASE", "ATLAS_VOICE_PERSONA_NAME", "ATLAS_VOICE_ENABLED",
  "ATLAS_VOICE_GREET_ON_START", "ATLAS_VOICE_SPEAK_COMPLETIONS",
  "ATLAS_VOICE_SUPPRESS", "ATLAS_VOICE_SUPPRESS_SUBAGENTS",
  // Developer-tool compatibility alias; config.json uses ECHO_PYTHON3_PATH.
  "PYTHON3_PATH",
]);

function isDeprecatedEnvironmentKey(key: string): boolean {
  return ECHO_CONFIG_KEYS.has(key) || DEPRECATED_ENV_ALIASES.has(key);
}

export function deprecatedEchoEnvironmentKeys(env: EchoEnvironment): string[] {
  return Object.keys(env)
    .filter((key) => env[key] !== undefined && isDeprecatedEnvironmentKey(key))
    .sort((left, right) => left.localeCompare(right));
}

export function warnDeprecatedEchoEnvironment(keys: string[], configPath: string): void {
  if (keys.length === 0) return;
  console.warn(
    `⚠️  Echo environment configuration is deprecated: ${keys.join(", ")}. ` +
      `Move these settings to ${configPath}; config.json values take precedence. ` +
      "Third-party secrets remain environment-only.",
  );
}

// Retired in this release: an old alias left in a dotenv file is ignored rather
// than migrated, so the canonical name is the only thing that can configure Echo.
const RETIRED_ALIAS_PREFIX = "VOICESYSTEM_";

// PORT is deliberately NOT migrated from the dotenv layer. The bash surfaces
// (scripts/echo-port.sh) read only config.json and a live PORT, and a second
// dotenv parser in bash could only drift from this one - so honoring a dotenv
// PORT here would put the daemon on a port every CLI, lifecycle script and
// health probe reports as down. scripts/migrate-config.ts moves an existing
// dotenv PORT into config.json, where both sides read it.
const DOTENV_EXCLUDED_KEYS = new Set(["PORT"]);

/** Reported by GET /health so an ignored key is visible without reading the log. */
export interface EchoConfigStatus {
  path: string;
  present: boolean;
  /** Keys dropped from an otherwise-usable file; every other key still applies. */
  ignored: string[];
  errors: string[];
  /** Canonical keys accepted from config.json; used to preserve precedence in core. */
  configured: string[];
  /** Echo settings supplied through the one-release environment compatibility layer. */
  deprecatedEnvironment: string[];
}

/**
 * Resolve the configuration file path. `env` defaults to an EMPTY object, not
 * process.env, so the default answer is deterministic; pass process.env at the
 * call site that wants the ECHO_CONFIG_FILE test/dev override honored. Reader
 * and writer share this one resolver so they can never target different files.
 */
export function echoConfigPath(homeDir: string = homedir(), env: EchoEnvironment = {}): string {
  return env.ECHO_CONFIG_FILE || join(homeDir, ...ECHO_CONFIG_PATH_PARTS);
}

function isConfigPrimitive(value: unknown): value is EchoConfigValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

// A configured port has to be one the pure-bash surfaces can target too: they
// resolve it without any of the daemon's fallback logic, so a value only the
// daemon accepts leaves every CLI, lifecycle script and health probe on 3246
// while the daemon listens elsewhere - permanently. `0` (ephemeral bind) is the
// clearest case, which is why it is rejected here and stays a live-process-only
// test mode. Keep these bounds in step with shared/config-schema.json and the
// range check in scripts/echo-port.sh.
export const MIN_CONFIG_PORT = 1;
export const MAX_CONFIG_PORT = 65535;

// One value, three readers: this validator, `parseInt(_, 10)` in core/server.ts,
// and the sed capture plus bash arithmetic in scripts/echo-port.sh. Each
// understands a different superset - `Number()` reads `0x0C9E` as 3230 where
// base-10 parsing stops at 0, bash reads a leading-zero operand as octal
// (`03246` → 1702), and a padded `" 3457 "` is a port to one reader and nothing
// to another - so the grammar is kept small enough that all three can mirror it
// exactly: digits only, no sign, no leading zero, no surrounding whitespace.
// Anything else resolves to 3246 everywhere. The same rule is spelled out in
// shared/config-schema.json and scripts/echo-port.sh, and every reader is held
// to it by tests/scripts/port-grammar.test.ts.
export const CANONICAL_DECIMAL = /^[1-9][0-9]*$/;

function parseConfigPort(entry: EchoConfigValue): number | null {
  if (typeof entry === "boolean") return null;
  const text = String(entry);
  return CANONICAL_DECIMAL.test(text) ? Number(text) : null;
}

/** The single per-key rule; both validation and loading go through it. */
function validateEchoConfigEntry(key: string, entry: unknown): string | null {
  if (key === "ELEVENLABS_API_KEY") {
    return "ELEVENLABS_API_KEY is a secret and must not be stored in config.json";
  }
  if (!ECHO_CONFIG_KEYS.has(key)) return `${key} is not an Echo configuration key`;
  if (!isConfigPrimitive(entry)) return `${key} must be a string, number, or boolean`;
  if (key === "PORT") {
    const port = parseConfigPort(entry);
    if (port === null || port < MIN_CONFIG_PORT || port > MAX_CONFIG_PORT) {
      return `PORT must be plain digits from ${MIN_CONFIG_PORT} to ${MAX_CONFIG_PORT} ` +
        "(no sign, leading zero, or surrounding whitespace)";
    }
  }
  return null;
}

/** Return schema violations without throwing, so a bad user file cannot stop startup. */
export function validateEchoConfig(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["configuration must be a JSON object"];
  }

  const errors: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const error = validateEchoConfigEntry(key, entry);
    if (error) errors.push(error);
  }
  return errors;
}

/**
 * Read config.json, dropping ONLY the keys that fail validation. An unknown key
 * (a typo, or a setting written by a newer Echo) must not revert every other
 * setting to its built-in default - the ignored keys and their reasons are
 * reported through EchoConfigStatus and surfaced in GET /health.
 */
function readJsonConfig(path: string): { values: Record<string, EchoConfigValue>; status: EchoConfigStatus } {
  const status: EchoConfigStatus = {
    path,
    present: false,
    ignored: [],
    errors: [],
    configured: [],
    deprecatedEnvironment: [],
  };
  if (!existsSync(path)) return { values: {}, status };
  status.present = true;

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    status.errors.push("file exists but could not be read");
    console.warn(`⚠️  Could not read Echo config at ${path}; using defaults`);
    return { values: {}, status };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    status.errors.push("file is not valid JSON");
    console.warn(`⚠️  Failed to load Echo config at ${path}; using defaults`);
    return { values: {}, status };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    status.errors.push("configuration must be a JSON object");
    console.warn(`⚠️  Invalid Echo config at ${path}: ${status.errors[0]}`);
    return { values: {}, status };
  }

  const values: Record<string, EchoConfigValue> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const error = validateEchoConfigEntry(key, entry);
    if (error) {
      status.ignored.push(key);
      status.errors.push(error);
      continue;
    }
    values[key] = entry as EchoConfigValue;
  }

  if (status.errors.length > 0) {
    console.warn(
      `⚠️  Ignoring ${status.ignored.length} key(s) in ${path}: ${status.errors.join("; ")}. ` +
        "Every other setting in the file still applies.",
    );
  }
  return { values, status };
}

/**
 * The one dotenv parser: the daemon's fallback layer and the migration tool
 * share it. Best-effort by contract - a file that exists but cannot be read
 * (permissions, or a directory at that path) yields no keys rather than
 * throwing, because this runs during daemon startup and inside install
 * preflight, where an exception is a dead service or a failed install.
 */
export function parseDotenvFile(path: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!existsSync(path)) return parsed;
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    console.warn(`⚠️  Could not read ${path}; skipping it`);
    return parsed;
  }
  for (const line of contents.split("\n")) {
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!key || !value || key.startsWith("#") || parsed[key] !== undefined) continue;
    parsed[key] = value;
  }
  return parsed;
}

/** The dotenv locations scripts/migrate-config.ts drains into config.json, in precedence order. */
export function legacyEchoEnvPaths(homeDir: string = homedir()): string[] {
  return [
    join(homeDir, ".config", "echo", ".env"),
    join(homeDir, ".config", "voicesystem", ".env"),
  ];
}

function loadLegacyEnvFiles(
  env: EchoEnvironment,
  homeDir: string,
  deprecatedEnvironment: Set<string>,
): EchoEnvironment {
  const envPaths = [
    ...(env.ECHO_ENV_PATHS?.split(":").filter(Boolean) ?? []),
    ...legacyEchoEnvPaths(homeDir),
    join(homeDir, ".env"),
  ];

  for (const envPath of envPaths) {
    // The .env reader is migration-only (plus the permanent home for
    // ELEVENLABS_API_KEY, the one secret config.json rejects). It retains the
    // old first-file-wins behavior but never overwrites a process value.
    for (const [key, value] of Object.entries(parseDotenvFile(envPath))) {
      if (key.startsWith(RETIRED_ALIAS_PREFIX)) continue;
      if (DOTENV_EXCLUDED_KEYS.has(key)) continue;
      if (env[key] === undefined) {
        env[key] = value;
        if (isDeprecatedEnvironmentKey(key)) deprecatedEnvironment.add(key);
      }
    }
  }
  return env;
}

/**
 * Resolve Echo configuration and report what the config file contributed.
 * Precedence: config.json, deprecated live process/explicit env object, then
 * legacy .env. The compatibility layers keep one upgrade from silently
 * breaking existing setups; third-party secrets remain environment-only.
 */
export function loadEchoConfigurationWithStatus(
  env: EchoEnvironment = { ...process.env },
  homeDir: string = homedir(),
): { env: EchoEnvironment; config: EchoConfigStatus } {
  const deprecatedEnvironment = new Set(deprecatedEchoEnvironmentKeys(env));
  const { values, status } = readJsonConfig(echoConfigPath(homeDir, env));
  status.configured = Object.keys(values).sort((left, right) => left.localeCompare(right));
  const resolved = loadLegacyEnvFiles({ ...env }, homeDir, deprecatedEnvironment);

  // Persistent Echo configuration is authoritative. Old environment values are
  // accepted for one release only and cannot silently override config.json.
  for (const [key, value] of Object.entries(values)) resolved[key] = String(value);

  status.deprecatedEnvironment = [...deprecatedEnvironment].sort((left, right) => left.localeCompare(right));
  warnDeprecatedEchoEnvironment(status.deprecatedEnvironment, status.path);
  return { env: resolved, config: status };
}

/** Resolve Echo configuration without mutating process.env. */
export function loadEchoConfiguration(
  env?: EchoEnvironment,
  homeDir?: string,
): EchoEnvironment {
  return loadEchoConfigurationWithStatus(env, homeDir).env;
}

// Compatibility name for adapters and extensions written against the Stage 1
// API. It now means "resolved Echo configuration", not just dotenv parsing.
export const loadEchoEnvironment = loadEchoConfiguration;

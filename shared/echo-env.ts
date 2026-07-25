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
  "ECHO_VOICE_PERSONA_NAME", "ECHO_VOICE_ID", "ECHO_VOICE_TITLE",
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
]);

export function echoConfigPath(homeDir: string = homedir()): string {
  return join(homeDir, ...ECHO_CONFIG_PATH_PARTS);
}

function isConfigPrimitive(value: unknown): value is EchoConfigValue {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/** Return schema violations without throwing, so a bad user file cannot stop startup. */
export function validateEchoConfig(value: unknown): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ["configuration must be a JSON object"];
  }

  const errors: string[] = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === "ELEVENLABS_API_KEY") {
      errors.push("ELEVENLABS_API_KEY is a secret and must not be stored in config.json");
    } else if (!ECHO_CONFIG_KEYS.has(key)) {
      errors.push(`${key} is not an Echo configuration key`);
    } else if (!isConfigPrimitive(entry)) {
      errors.push(`${key} must be a string, number, or boolean`);
    }
  }
  return errors;
}

function readJsonConfig(path: string): Record<string, EchoConfigValue> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const errors = validateEchoConfig(parsed);
    if (errors.length > 0) {
      console.warn(`⚠️  Invalid Echo config at ${path}: ${errors.join("; ")}`);
      return {};
    }
    return parsed as Record<string, EchoConfigValue>;
  } catch {
    console.warn(`⚠️  Failed to load Echo config at ${path}; using defaults`);
    return {};
  }
}

function loadLegacyEnvFiles(env: EchoEnvironment, homeDir: string): EchoEnvironment {
  const envPaths = [
    ...(env.ECHO_ENV_PATHS?.split(":").filter(Boolean) ?? []),
    join(homeDir, ".config", "echo", ".env"),
    join(homeDir, ".config", "voicesystem", ".env"),
    join(homeDir, ".env"),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;
      const key = line.slice(0, eqIndex).trim();
      let value = line.slice(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // The .env reader is migration-only. It retains the old first-file-wins
      // behavior but never overwrites a process or JSON-configured value.
      if (key && value && !key.startsWith("#") && env[key] === undefined) env[key] = value;
    }
  }
  return env;
}

/**
 * Resolve Echo configuration without mutating process.env.
 * Precedence: live process/explicit env object, config.json, then legacy .env.
 * The final layer exists only to keep an upgrade from silently changing behavior;
 * migrate those values to config.json and remove the old file when convenient.
 */
export function loadEchoConfiguration(
  env: EchoEnvironment = { ...process.env },
  homeDir: string = homedir(),
): EchoEnvironment {
  const resolved: EchoEnvironment = { ...env };
  const config = readJsonConfig(echoConfigPath(homeDir));
  for (const [key, value] of Object.entries(config)) {
    if (resolved[key] === undefined) resolved[key] = String(value);
  }
  return loadLegacyEnvFiles(resolved, homeDir);
}

// Compatibility name for adapters and extensions written against the Stage 1
// API. It now means "resolved Echo configuration", not just dotenv parsing.
export const loadEchoEnvironment = loadEchoConfiguration;

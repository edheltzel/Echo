import { JSON5 } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { defaultStartupGreetings, personaGreetingFields } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { applyPersonaOverride, booleanEnv, type EchoPersonaOverride } from "@echo/shared/persona.ts";
import { openCodeConfigLayers } from "./config-path.ts";

export interface OpenCodeVoiceConfig {
  endpoint: string;
  title: string;
  startupCatchphrases: string[];
  personaName: string;
  sayName: boolean;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
}

function defaultReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** remeda `mergeDeep`, which OpenCode merges config with: objects per key, anything else replaced. */
function mergeDeep(base: Json, next: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(next)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? mergeDeep(current, value) : value;
  }
  return out;
}

function readDaidentity(path: string, readFile: (path: string) => string | null): Json | null {
  const raw = readFile(path);
  if (!raw?.trim()) return null;
  try {
    const parsed: unknown = JSON5.parse(raw);
    const d = isPlainObject(parsed) ? parsed.daidentity : undefined;
    return isPlainObject(d) ? d : null;
  } catch {
    return null;
  }
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * `daidentity` merged across every config file OpenCode itself merges for a
 * session in `cwd` (see `openCodeConfigLayers`), so Echo resolves the same
 * persona OpenCode's own config does.
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = process.env.HOME ?? homedir(),
  env: Record<string, string | undefined> = process.env,
  worktree?: string,
): EchoPersonaOverride | null {
  const layers = openCodeConfigLayers({ env, home, cwd, worktree })
    .map((path) => readDaidentity(path, readFile))
    .filter((d): d is Json => d !== null);
  if (layers.length === 0) return null;
  const merged = layers.reduce(mergeDeep);

  // A voice has two spellings. Resolve it per file first, then let the
  // highest-priority file that sets one win; a raw deep merge would let a
  // lower file's nested voices.main.voiceId beat a higher file's flat voiceId.
  const voiceOf = (d: Json): string | undefined => {
    const main = isPlainObject(d.voices) && isPlainObject(d.voices.main) ? d.voices.main : undefined;
    return trimmedString(main?.voiceId) ?? trimmedString(d.voiceId);
  };
  const name = trimmedString(merged.name);
  const voiceId = layers.map(voiceOf).findLast((voice) => voice !== undefined);
  const greeting = personaGreetingFields(merged, null);

  const override: EchoPersonaOverride = {};
  if (name) override.personaName = name;
  if (voiceId) override.voiceId = voiceId;
  if (greeting.phrases) override.startupCatchphrases = greeting.phrases;
  if (greeting.sayName !== undefined) override.sayName = greeting.sayName;
  return Object.keys(override).length > 0 ? override : null;
}

export function loadOpenCodeVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
  home: string = process.env.HOME ?? homedir(),
  worktree?: string,
): OpenCodeVoiceConfig {
  const catchphrase = env.ECHO_VOICE_CATCHPHRASE;
  const sayName = booleanEnv(env.ECHO_VOICE_SAY_NAME, false);
  const base: OpenCodeVoiceConfig = {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "OpenCode Notification",
    startupCatchphrases: catchphrase === undefined ? defaultStartupGreetings(sayName) : [catchphrase],
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "OpenCode",
    sayName,
    voiceId: env.ECHO_VOICE_ID ?? "opencode",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, false),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
  return applyPersonaOverride(base, loadProjectPersona(cwd, defaultReadFile, home, env, worktree));
}

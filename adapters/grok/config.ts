import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { applyPersonaOverride, booleanEnv, type EchoPersonaOverride } from "@echo/shared/persona.ts";

export interface GrokVoiceConfig {
  endpoint: string;
  title: string;
  personaName: string;
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

function readDaidentity(
  path: string,
  readFile: (path: string) => string | null,
): Record<string, any> | null {
  const raw = readFile(path);
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as Record<string, any>;
    const d = json?.daidentity;
    return d && typeof d === "object" ? (d as Record<string, any>) : null;
  } catch {
    return null;
  }
}

// Same daidentity shape as Claude Code / Pi / omp:
//   { "daidentity": { "name": "Themis",
//                     "voices": { "main": { "voiceId": "en-GB-LibbyNeural" } } } }
/**
 * Project `<cwd>/.grok/settings.json` over global `~/.grok/settings.json`,
 * project wins per key (matches Pi/Claude daidentity layering).
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = readDaidentity(join(home, ".grok", "settings.json"), readFile);
  const project = cwd ? readDaidentity(join(cwd, ".grok", "settings.json"), readFile) : null;
  if (!global && !project) return null;

  const voiceOf = (d: Record<string, any> | null): unknown =>
    d?.voices?.main?.voiceId ?? d?.voiceId;
  const name = project?.name ?? global?.name;
  const voiceId = voiceOf(project) ?? voiceOf(global);

  const override: EchoPersonaOverride = {};
  if (typeof name === "string" && name.trim()) override.personaName = name.trim();
  if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
  return Object.keys(override).length > 0 ? override : null;
}

export function loadGrokVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
): GrokVoiceConfig {
  const base: GrokVoiceConfig = {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Grok Notification",
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Grok",
    voiceId: env.ECHO_VOICE_ID ?? "grok",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
  return applyPersonaOverride(base, loadProjectPersona(cwd));
}

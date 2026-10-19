import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { preferredHumanName } from "@echo/shared/hil.ts";
import { applyPersonaOverride, booleanEnv, type EchoPersonaOverride } from "@echo/shared/persona.ts";

export interface EmpryoVoiceConfig {
  endpoint: string;
  title: string;
  personaName: string;
  preferredName?: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
  suppress: boolean;
  suppressChildTabs: boolean;
}

function defaultReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

function readDaidentity(path: string, readFile: (path: string) => string | null): Record<string, any> | null {
  const raw = readFile(path);
  if (!raw) return null;
  try {
    const identity = (JSON.parse(raw) as Record<string, any>)?.daidentity;
    return identity && typeof identity === "object" ? identity : null;
  } catch {
    return null;
  }
}

/** Project `<cwd>/.empryo/settings.json` over global `~/.empryo/settings.json`, per key. */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = readDaidentity(join(home, ".empryo", "settings.json"), readFile);
  const project = cwd ? readDaidentity(join(cwd, ".empryo", "settings.json"), readFile) : null;
  if (!global && !project) return null;
  const voiceOf = (identity: Record<string, any> | null): unknown => identity?.voices?.main?.voiceId ?? identity?.voiceId;
  const name = project?.name ?? global?.name;
  const voiceId = voiceOf(project) ?? voiceOf(global);
  const override: EchoPersonaOverride = {};
  if (typeof name === "string" && name.trim()) override.personaName = name.trim();
  if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
  return Object.keys(override).length > 0 ? override : null;
}

export function loadEmpryoVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  cwd?: string,
): EmpryoVoiceConfig {
  return applyPersonaOverride({
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Empryo Notification",
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Empryo",
    preferredName: preferredHumanName(env),
    voiceId: env.ECHO_VOICE_ID,
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
    suppress: booleanEnv(env.ECHO_VOICE_SUPPRESS, false),
    // Tabs the agent opened for itself. Tabs the operator opened always speak.
    suppressChildTabs: booleanEnv(env.ECHO_VOICE_SUPPRESS_CHILD_TABS, true),
  }, loadProjectPersona(cwd));
}

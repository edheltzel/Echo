import { JSON5 } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { defaultStartupGreetings, personaGreetingFields } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { applyPersonaOverride, booleanEnv, type EchoPersonaOverride } from "@echo/shared/persona.ts";
import { resolveOpenCodeConfigPath, resolveProjectOpenCodeConfigPath } from "./config-path.ts";

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

function readDaidentity(
  path: string,
  readFile: (path: string) => string | null,
): Record<string, any> | null {
  const raw = readFile(path);
  if (!raw) return null;
  try {
    const json = JSON5.parse(raw) as Record<string, any>;
    const d = json?.daidentity;
    return d && typeof d === "object" ? (d as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * Project opencode.jsonc / opencode.json over the global file OpenCode actually
 * loads. Official OpenCode config paths (not `.opencode/config.json`).
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = process.env.HOME ?? homedir(),
  env: Record<string, string | undefined> = process.env,
): EchoPersonaOverride | null {
  const exists = (path: string) => readFile(path) !== null;
  const global = readDaidentity(resolveOpenCodeConfigPath(env, home, exists), readFile);
  const projectPath = cwd ? resolveProjectOpenCodeConfigPath(cwd, exists) : undefined;
  const project = projectPath ? readDaidentity(projectPath, readFile) : null;
  if (!global && !project) return null;

  const voiceOf = (d: Record<string, any> | null): unknown =>
    d?.voices?.main?.voiceId ?? d?.voiceId;
  const name = project?.name ?? global?.name;
  const voiceId = voiceOf(project) ?? voiceOf(global);
  const greeting = personaGreetingFields(project, global);

  const override: EchoPersonaOverride = {};
  if (typeof name === "string" && name.trim()) override.personaName = name.trim();
  if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
  if (greeting.phrases) override.startupCatchphrases = greeting.phrases;
  if (greeting.sayName !== undefined) override.sayName = greeting.sayName;
  return Object.keys(override).length > 0 ? override : null;
}

export function loadOpenCodeVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
  home: string = process.env.HOME ?? homedir(),
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
  return applyPersonaOverride(base, loadProjectPersona(cwd, defaultReadFile, home, env));
}

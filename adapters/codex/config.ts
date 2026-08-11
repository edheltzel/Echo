import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA_GREETINGS } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";

export interface CodexVoiceConfig {
  endpoint: string;
  title: string;
  startupCatchphrases: string[];
  personaName: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
}

export interface EchoPersonaOverride {
  personaName?: string;
  voiceId?: string;
  startupCatchphrases?: string[];
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
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

/**
 * Project `<cwd>/.codex/settings.json` over global `~/.codex/settings.json`.
 * Same daidentity shape as Claude Code / Pi / Grok.
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = readDaidentity(join(home, ".codex", "settings.json"), readFile);
  const project = cwd ? readDaidentity(join(cwd, ".codex", "settings.json"), readFile) : null;
  if (!global && !project) return null;

  const voiceOf = (d: Record<string, any> | null): unknown =>
    d?.voices?.main?.voiceId ?? d?.voiceId;
  const name = project?.name ?? global?.name;
  const voiceId = voiceOf(project) ?? voiceOf(global);
  const rawPhrases = project?.startupCatchphrases ?? global?.startupCatchphrases;
  const phrases = Array.isArray(rawPhrases)
    ? (rawPhrases as unknown[]).filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : undefined;

  const override: EchoPersonaOverride = {};
  if (typeof name === "string" && name.trim()) override.personaName = name.trim();
  if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
  if (phrases && phrases.length > 0) override.startupCatchphrases = phrases;
  return Object.keys(override).length > 0 ? override : null;
}

export function applyPersonaOverride(
  base: CodexVoiceConfig,
  override: EchoPersonaOverride | null,
): CodexVoiceConfig {
  if (!override) return base;
  const startupCatchphrases = override.startupCatchphrases
    ?? (override.personaName ? DEFAULT_PERSONA_GREETINGS : base.startupCatchphrases);
  return {
    ...base,
    personaName: override.personaName ?? base.personaName,
    voiceId: override.voiceId ?? base.voiceId,
    startupCatchphrases,
  };
}

export function loadCodexVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
): CodexVoiceConfig {
  const catchphrase = env.ECHO_VOICE_CATCHPHRASE;
  const base: CodexVoiceConfig = {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Codex Notification",
    startupCatchphrases: catchphrase === undefined ? DEFAULT_PERSONA_GREETINGS : [catchphrase],
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Codex",
    voiceId: env.ECHO_VOICE_ID ?? "codex",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, false),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
  return applyPersonaOverride(base, loadProjectPersona(cwd));
}

export function pickStartupCatchphrase(pool: string[], random: () => number = Math.random): string {
  return pool[Math.floor(random() * pool.length)];
}

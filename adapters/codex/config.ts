import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA_GREETINGS } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import {
  applyPersonaOverride,
  booleanEnv,
  mergeDaidentity,
  parseJsonDaidentity,
  readTextFile,
  type EchoPersonaOverride,
} from "@echo/shared/persona.ts";

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

/**
 * Project `<cwd>/.codex/settings.json` over global `~/.codex/settings.json`.
 * Not `config.toml`. Project wins per key, then env / adapter defaults.
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = readTextFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = parseJsonDaidentity(readFile(join(home, ".codex", "settings.json")));
  const project = cwd ? parseJsonDaidentity(readFile(join(cwd, ".codex", "settings.json"))) : null;
  return mergeDaidentity(project, global);
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

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

export interface GrokVoiceConfig {
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
 * Project `<cwd>/.grok/settings.json` over global `~/.grok/settings.json`.
 * Project wins per key, then env / adapter defaults.
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = readTextFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = parseJsonDaidentity(readFile(join(home, ".grok", "settings.json")));
  const project = cwd ? parseJsonDaidentity(readFile(join(cwd, ".grok", "settings.json"))) : null;
  return mergeDaidentity(project, global);
}

export function loadGrokVoiceConfig(
  env: Record<string, string | undefined> = process.env,
  cwd: string | undefined = process.cwd(),
): GrokVoiceConfig {
  const catchphrase = env.ECHO_VOICE_CATCHPHRASE;
  const base: GrokVoiceConfig = {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Grok Notification",
    startupCatchphrases: catchphrase === undefined ? DEFAULT_PERSONA_GREETINGS : [catchphrase],
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Grok",
    voiceId: env.ECHO_VOICE_ID ?? "grok",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    // Grok fires SessionStart for every new TUI/headless session. Keep greetings
    // opt-in so a busy operator does not get a spoken line on every launch.
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, false),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
  return applyPersonaOverride(base, loadProjectPersona(cwd));
}


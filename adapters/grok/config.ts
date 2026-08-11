import { DEFAULT_PERSONA_GREETINGS } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";

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

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadGrokVoiceConfig(
  env: Record<string, string | undefined> = process.env,
): GrokVoiceConfig {
  const catchphrase = env.ECHO_VOICE_CATCHPHRASE;
  return {
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
}

export function pickStartupCatchphrase(pool: string[], random: () => number = Math.random): string {
  return pool[Math.floor(random() * pool.length)];
}

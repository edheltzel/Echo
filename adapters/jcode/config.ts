import { defaultStartupGreetings } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";

export interface JcodeVoiceConfig {
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

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadJcodeVoiceConfig(
  env: Record<string, string | undefined> = process.env,
): JcodeVoiceConfig {
  const catchphrase = env.ECHO_VOICE_CATCHPHRASE;
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Jcode Notification",
    startupCatchphrases: catchphrase === undefined ? defaultStartupGreetings(false) : [catchphrase],
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Jcode",
    sayName: false,
    voiceId: env.ECHO_VOICE_ID,
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    // Jcode fires lifecycle hooks for TUI, headless, and swarm workers without a
    // foreground/child discriminator. Keep greetings opt-in to avoid session floods.
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, false),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
}

export function pickStartupCatchphrase(pool: string[], random: () => number = Math.random): string {
  return pool[Math.floor(random() * pool.length)];
}

import { DEFAULT_PERSONA_GREETINGS } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { booleanEnv } from "@echo/shared/persona.ts";

export interface JcodeVoiceConfig {
  endpoint: string;
  title: string;
  startupCatchphrases: string[];
  personaName: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
}

export function loadJcodeVoiceConfig(
  env: Record<string, string | undefined> = process.env,
): JcodeVoiceConfig {
  const catchphrase = env.ECHO_VOICE_CATCHPHRASE;
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Jcode Notification",
    startupCatchphrases: catchphrase === undefined ? DEFAULT_PERSONA_GREETINGS : [catchphrase],
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Jcode",
    voiceId: env.ECHO_VOICE_ID,
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    // Jcode fires lifecycle hooks for TUI, headless, and swarm workers without a
    // foreground/child discriminator. Keep greetings opt-in to avoid session floods.
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, false),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
}


import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { booleanEnv } from "@echo/shared/persona.ts";

export interface JcodeVoiceConfig {
  endpoint: string;
  title: string;
  personaName: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
}

export function loadJcodeVoiceConfig(
  env: Record<string, string | undefined> = process.env,
): JcodeVoiceConfig {
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? "Jcode Notification",
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? "Jcode",
    voiceId: env.ECHO_VOICE_ID,
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED, true),
    // Root create sessions greet. Resume/attach and child sessions stay silent.
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS, true),
  };
}


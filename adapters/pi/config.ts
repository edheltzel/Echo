export interface PiVoiceConfig {
  endpoint: string;
  title: string;
  catchphrase: string;
  personaName: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
  suppressInSubagents: boolean;
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadPiVoiceConfig(env: Record<string, string | undefined> = process.env): PiVoiceConfig {
  return {
    endpoint: env.ATLAS_VOICE_NOTIFY_URL || env.VOICESYSTEM_NOTIFY_URL || "http://localhost:8888/notify",
    title: env.ATLAS_VOICE_TITLE || "Pi Notification",
    catchphrase: env.ATLAS_VOICE_CATCHPHRASE || "Pi session ready.",
    personaName: env.ATLAS_VOICE_PERSONA_NAME || "Atlas",
    voiceId: env.ATLAS_VOICE_ID || env.VOICESYSTEM_VOICE_ID || undefined,
    voiceEnabled: booleanEnv(env.ATLAS_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ATLAS_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ATLAS_VOICE_SPEAK_COMPLETIONS, true),
    suppressInSubagents: booleanEnv(env.ATLAS_VOICE_SUPPRESS_SUBAGENTS, true),
  };
}

/** Subset of Pi's ExtensionContext needed to decide suppression. */
export interface RunContext {
  mode?: string;
  hasUI?: boolean;
}

export function shouldSuppressVoice(
  ctx: RunContext = {},
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (booleanEnv(env.ATLAS_VOICE_SUPPRESS, false)) return true;
  // Pi spawns subagents as a child `pi --mode json -p --no-session`. Those headless
  // run modes have no user-facing UI (ctx.hasUI === false), so to avoid an audio
  // flood we speak only when a real UI is present. `tui` and `rpc` keep their UI.
  if (ctx.hasUI === false) return true;
  if (ctx.mode === "json" || ctx.mode === "print") return true;
  return false;
}

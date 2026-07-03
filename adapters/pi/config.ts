export interface PiVoiceConfig {
  endpoint: string;
  title: string;
  startupCatchphrases: string[];
  personaName: string;
  voiceId?: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
  suppressInSubagents: boolean;
}

// Default greeting pool, mirroring the Claude Code adapter's startupCatchphrases
// mechanism (VoiceGreeting.hook.ts): short neutral session-ready lines, random
// pick per session_start. No hardcoded persona/DA name — Pi and omp share this
// adapter (neutral-default-identity rule). A catchphrase env override replaces
// the pool with that single line, pinning the greeting.
export const DEFAULT_STARTUP_CATCHPHRASES: string[] = [
  "Session ready.",
  "Ready when you are.",
  "Online and standing by.",
  "Let's get to work.",
  "Up and listening.",
];

/** Random pick from the greeting pool; `random` is injectable for tests. */
export function pickStartupCatchphrase(
  pool: string[],
  random: () => number = Math.random,
): string {
  return pool[Math.floor(random() * pool.length)];
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function loadPiVoiceConfig(env: Record<string, string | undefined> = process.env): PiVoiceConfig {
  // Canonical ECHO_* names are read first; the legacy ATLAS_VOICE_* / VOICESYSTEM_*
  // names remain as silent, deprecated fallbacks (see README "Deprecated environment
  // variables"). NOTIFY_URL and VOICE_ID converge two legacy names onto one canonical.
  const catchphraseOverride = env.ECHO_VOICE_CATCHPHRASE ?? env.ATLAS_VOICE_CATCHPHRASE;
  return {
    endpoint: env.ECHO_NOTIFY_URL ?? env.ATLAS_VOICE_NOTIFY_URL ?? env.VOICESYSTEM_NOTIFY_URL ?? "http://localhost:8888/notify",
    title: env.ECHO_VOICE_TITLE ?? env.ATLAS_VOICE_TITLE ?? "Pi Notification",
    startupCatchphrases: catchphraseOverride !== undefined ? [catchphraseOverride] : DEFAULT_STARTUP_CATCHPHRASES,
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? env.ATLAS_VOICE_PERSONA_NAME ?? "Pi",
    voiceId: env.ECHO_VOICE_ID ?? env.ATLAS_VOICE_ID ?? env.VOICESYSTEM_VOICE_ID ?? "pi",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED ?? env.ATLAS_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START ?? env.ATLAS_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS ?? env.ATLAS_VOICE_SPEAK_COMPLETIONS, true),
    suppressInSubagents: booleanEnv(env.ECHO_VOICE_SUPPRESS_SUBAGENTS ?? env.ATLAS_VOICE_SUPPRESS_SUBAGENTS, true),
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
  if (booleanEnv(env.ECHO_VOICE_SUPPRESS ?? env.ATLAS_VOICE_SUPPRESS, false)) return true;
  // Pi spawns subagents as a child `pi --mode json -p --no-session`. Those headless
  // run modes have no user-facing UI (ctx.hasUI === false), so to avoid an audio
  // flood we speak only when a real UI is present. `tui` and `rpc` keep their UI.
  if (ctx.hasUI === false) return true;
  if (ctx.mode === "json" || ctx.mode === "print") return true;
  return false;
}

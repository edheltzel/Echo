import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
  // names remain as silent, deprecated fallbacks (see docs/configuration.md "Deprecated
  // environment variables"). NOTIFY_URL and VOICE_ID converge two legacy names onto one canonical.
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

// ── Project-local persona override ───────────────────────────────────────────
// A project can override the persona name + voice (+ catchphrases) for THIS repo
// only, via an Echo-owned file in Pi's native config dir: `<cwd>/.pi/echo-voice.json`.
// Pi extensions read their own `.pi/` config through `ctx.cwd` (Pi exposes no
// settings namespace for extensions and its settings.json validation is
// undocumented — so we never touch the user's `.pi/settings.json`). The file uses
// the SAME `daidentity` shape as the Claude Code adapter, so a persona is one shape
// across hosts:
//   { "daidentity": { "name": "Echo",
//                     "voices": { "main": { "voiceId": "en-US-AndrewNeural" } },
//                     "startupCatchphrases": ["Echo online."] } }
// The block may also be written unwrapped (fields at the top level). Missing or
// malformed → null (no override; the env-based global config stands).

export interface EchoPersonaOverride {
  personaName?: string;
  voiceId?: string;
  startupCatchphrases?: string[];
}

function defaultReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
): EchoPersonaOverride | null {
  if (!cwd) return null;
  const raw = readFile(join(cwd, ".pi", "echo-voice.json"));
  if (!raw) return null;

  try {
    const json = JSON.parse(raw) as Record<string, any>;
    const d = (json?.daidentity ?? json ?? {}) as Record<string, any>;
    const voiceId = d?.voices?.main?.voiceId ?? d?.voiceId;
    const phrases = Array.isArray(d?.startupCatchphrases)
      ? (d.startupCatchphrases as unknown[]).filter(
          (c): c is string => typeof c === "string" && c.trim().length > 0,
        )
      : undefined;

    const override: EchoPersonaOverride = {};
    if (typeof d?.name === "string" && d.name.trim()) override.personaName = d.name.trim();
    if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
    if (phrases && phrases.length > 0) override.startupCatchphrases = phrases;

    return Object.keys(override).length > 0 ? override : null;
  } catch {
    return null;
  }
}

/** Apply a project persona override onto a base config, per key (override wins when set). */
export function applyPersonaOverride(
  base: PiVoiceConfig,
  override: EchoPersonaOverride | null,
): PiVoiceConfig {
  if (!override) return base;
  return {
    ...base,
    personaName: override.personaName ?? base.personaName,
    voiceId: override.voiceId ?? base.voiceId,
    startupCatchphrases: override.startupCatchphrases ?? base.startupCatchphrases,
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

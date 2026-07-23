import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PERSONA_GREETINGS } from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";

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
  // environment variables"). VOICE_ID converges two legacy names onto one canonical;
  // the notify endpoint is resolved by @echo/shared so ECHO_DAEMON_URL retargets it.
  const catchphraseOverride = env.ECHO_VOICE_CATCHPHRASE ?? env.ATLAS_VOICE_CATCHPHRASE;
  return {
    endpoint: resolveNotifyUrl(env),
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

// ── Project persona override (Pi-native settings.json) ───────────────────────
// A project can override the persona name + voice (+ catchphrases) for THIS repo
// only, via the SAME convention as the Claude Code adapter: a `daidentity` block
// in the host's native settings.json. Pi layers config exactly like Claude Code —
// `<cwd>/.pi/settings.json` (project) over `~/.pi/agent/settings.json` (global),
// project wins per key — so Echo reads the `daidentity` block from both and merges
// project-over-global:
//   { "daidentity": { "name": "Echo",
//                     "voices": { "main": { "voiceId": "en-US-AndrewNeural" } },
//                     "startupCatchphrases": ["Echo online."] } }
// Unset keys fall through to global settings, then to the env-based config.

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

/** Parse a settings.json file and return its `daidentity` block (or null). */
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
 * Resolve a persona override from Pi's native settings.json layering:
 * project `<cwd>/.pi/settings.json` over global `~/.pi/agent/settings.json`,
 * project wins per key (the same daidentity shape the Claude Code adapter reads).
 * Returns null when neither file contributes a persona field.
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = readDaidentity(join(home, ".pi", "agent", "settings.json"), readFile);
  const project = cwd ? readDaidentity(join(cwd, ".pi", "settings.json"), readFile) : null;
  if (!global && !project) return null;

  // Per-key resolution: project wins, else global. Voice supports the nested
  // `voices.main.voiceId` shape (and a flat `voiceId`), matching Claude Code.
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

/** Apply a project persona override onto a base config, per key (override wins when set). */
export function applyPersonaOverride(
  base: PiVoiceConfig,
  override: EchoPersonaOverride | null,
): PiVoiceConfig {
  if (!override) return base;
  // When a repo sets a persona NAME but no startup lines of its own, announce that
  // name at startup (the `{name}` default pool) instead of the neutral base pool —
  // its own catchphrases still win when present. Greeting-time code substitutes `{name}`.
  const startupCatchphrases = override.startupCatchphrases
    ?? (override.personaName ? DEFAULT_PERSONA_GREETINGS : base.startupCatchphrases);
  return {
    ...base,
    personaName: override.personaName ?? base.personaName,
    voiceId: override.voiceId ?? base.voiceId,
    startupCatchphrases,
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

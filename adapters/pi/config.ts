import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  defaultStartupGreetings,
  personaGreetingFields,
  pickStartupCatchphrase,
} from "@echo/shared/greeting.ts";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { loadEchoConfiguration } from "@echo/shared/echo-env.ts";
import {
  applyPersonaOverride,
  booleanEnv,
  shouldSuppressVoice,
  type BaseVoiceConfig,
  type EchoPersonaOverride,
  type RunContext,
} from "@echo/shared/persona.ts";

export type { EchoPersonaOverride, RunContext };
export { applyPersonaOverride, pickStartupCatchphrase, shouldSuppressVoice };

export interface PiVoiceConfig extends BaseVoiceConfig {
  endpoint: string;
  title: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
  suppressInSubagents: boolean;
}

// Default greeting pool lives in @echo/shared/greeting.ts (nameless unless sayName).

export function loadPiVoiceConfig(env: Record<string, string | undefined> = loadEchoConfiguration()): PiVoiceConfig {
  // Canonical config.json values are read first; legacy ATLAS_VOICE_* process
  // values remain deprecated fallbacks (see docs/configuration.md). The notify
  // endpoint is resolved by @echo/shared, so
  // ECHO_DAEMON_URL retargets it.
  const catchphraseOverride = env.ECHO_VOICE_CATCHPHRASE ?? env.ATLAS_VOICE_CATCHPHRASE;
  const sayName = booleanEnv(env.ECHO_VOICE_SAY_NAME, false);
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? env.ATLAS_VOICE_TITLE ?? "Pi Notification",
    startupCatchphrases: catchphraseOverride !== undefined ? [catchphraseOverride] : defaultStartupGreetings(sayName),
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? env.ATLAS_VOICE_PERSONA_NAME ?? "Pi",
    sayName,
    voiceId: env.ECHO_VOICE_ID ?? env.ATLAS_VOICE_ID ?? "pi",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED ?? env.ATLAS_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START ?? env.ATLAS_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS ?? env.ATLAS_VOICE_SPEAK_COMPLETIONS, true),
    suppressInSubagents: booleanEnv(env.ECHO_VOICE_SUPPRESS_SUBAGENTS ?? env.ATLAS_VOICE_SUPPRESS_SUBAGENTS, true),
  };
}

// ── Project persona override (Pi-native settings.json) ───────────────────────
// A project can override the persona name + voice (+ catchphrases) for THIS repo
// only, via the SAME convention as the Claude Code adapter: a `daidentity` block
// in the host's native settings.json. Pi layers config exactly like Claude Code -
// `<cwd>/.pi/settings.json` (project) over `~/.pi/agent/settings.json` (global),
// project wins per key - so Echo reads the `daidentity` block from both and merges
// project-over-global:
//   { "daidentity": { "name": "Echo",
//                     "voices": { "main": { "voiceId": "en-US-AndrewNeural" } },
//                     "startupCatchphrases": ["Echo online."] } }
// Unset keys fall through to global settings, then to the env-based config.

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
 * Host-specific: Pi's JSON `.pi/settings.json` paths, not a shared helper.
 * Project `<cwd>/.pi/settings.json` over global `~/.pi/agent/settings.json`,
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
  const greeting = personaGreetingFields(project, global);

  const override: EchoPersonaOverride = {};
  if (typeof name === "string" && name.trim()) override.personaName = name.trim();
  if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
  if (greeting.phrases) override.startupCatchphrases = greeting.phrases;
  if (greeting.sayName !== undefined) override.sayName = greeting.sayName;

  return Object.keys(override).length > 0 ? override : null;
}

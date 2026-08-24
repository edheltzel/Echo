import { homedir } from "node:os";
import { join } from "node:path";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { loadEchoConfiguration } from "@echo/shared/echo-env.ts";
import {
  booleanEnv,
  mergeDaidentity,
  parseJsonDaidentity,
  readTextFile,
  type EchoPersonaOverride,
} from "@echo/shared/persona.ts";

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
// pick per session_start. No hardcoded persona/DA name - Pi and omp share this
// adapter (neutral-default-identity rule). A catchphrase env override replaces
// the pool with that single line, pinning the greeting.
export const DEFAULT_STARTUP_CATCHPHRASES: string[] = [
  "Session ready.",
  "Ready when you are.",
  "Online and standing by.",
  "Let's get to work.",
  "Up and listening.",
];


export function loadPiVoiceConfig(env: Record<string, string | undefined> = loadEchoConfiguration()): PiVoiceConfig {
  // Canonical config.json values are read first; legacy ATLAS_VOICE_* process
  // values remain deprecated fallbacks (see docs/configuration.md). The notify
  // endpoint is resolved by @echo/shared, so
  // ECHO_DAEMON_URL retargets it.
  const catchphraseOverride = env.ECHO_VOICE_CATCHPHRASE ?? env.ATLAS_VOICE_CATCHPHRASE;
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? env.ATLAS_VOICE_TITLE ?? "Pi Notification",
    startupCatchphrases: catchphraseOverride !== undefined ? [catchphraseOverride] : DEFAULT_STARTUP_CATCHPHRASES,
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? env.ATLAS_VOICE_PERSONA_NAME ?? "Pi",
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

/** Project `.pi/settings.json` over `~/.pi/agent/settings.json`, then env. */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = readTextFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = parseJsonDaidentity(readFile(join(home, ".pi", "agent", "settings.json")));
  const project = cwd ? parseJsonDaidentity(readFile(join(cwd, ".pi", "settings.json"))) : null;
  return mergeDaidentity(project, global);
}

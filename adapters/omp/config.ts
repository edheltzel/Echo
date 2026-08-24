import { homedir } from "node:os";
import { join } from "node:path";
import { resolveNotifyUrl } from "@echo/shared/daemon-endpoints.ts";
import { loadEchoConfiguration } from "@echo/shared/echo-env.ts";
import {
  booleanEnv,
  mergeDaidentity,
  readTextFile,
  type EchoPersonaOverride,
} from "@echo/shared/persona.ts";

export interface OmpVoiceConfig {
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

// Default greeting pool - short neutral session-ready lines, random pick per
// session_start. No hardcoded persona/DA name (neutral-default-identity rule); a
// catchphrase env override replaces the pool with that single pinned line.
export const DEFAULT_STARTUP_CATCHPHRASES: string[] = [
  "Session ready.",
  "Ready when you are.",
  "Online and standing by.",
  "Let's get to work.",
  "Up and listening.",
];


export function loadOmpVoiceConfig(env: Record<string, string | undefined> = loadEchoConfiguration()): OmpVoiceConfig {
  // Same canonical config.json values as the Pi adapter. Legacy ATLAS_VOICE_*
  // process values remain deprecated fallbacks. omp defaults to persona "omp"
  // and shares Pi's "pi" voice mapping unless a project identity overrides it.
  const catchphraseOverride = env.ECHO_VOICE_CATCHPHRASE ?? env.ATLAS_VOICE_CATCHPHRASE;
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? env.ATLAS_VOICE_TITLE ?? "omp Notification",
    startupCatchphrases: catchphraseOverride !== undefined ? [catchphraseOverride] : DEFAULT_STARTUP_CATCHPHRASES,
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? env.ATLAS_VOICE_PERSONA_NAME ?? "omp",
    voiceId: env.ECHO_VOICE_ID ?? env.ATLAS_VOICE_ID ?? "pi",
    voiceEnabled: booleanEnv(env.ECHO_VOICE_ENABLED ?? env.ATLAS_VOICE_ENABLED, true),
    greetOnSessionStart: booleanEnv(env.ECHO_VOICE_GREET_ON_START ?? env.ATLAS_VOICE_GREET_ON_START, true),
    speakCompletions: booleanEnv(env.ECHO_VOICE_SPEAK_COMPLETIONS ?? env.ATLAS_VOICE_SPEAK_COMPLETIONS, true),
    suppressInSubagents: booleanEnv(env.ECHO_VOICE_SUPPRESS_SUBAGENTS ?? env.ATLAS_VOICE_SUPPRESS_SUBAGENTS, true),
  };
}

// ── Project persona override (omp-native YAML config) ────────────────────────
// A project can override the persona name + voice (+ catchphrases) for THIS repo
// only, via the SAME convention as the Claude Code and Pi adapters: a `daidentity`
// block in the host's native config. omp's config is YAML, layered project-over-user
// - so Echo reads the `daidentity` block from `<cwd>/.omp/config.yml` (project) and
// `~/.omp/agent/config.yml` (global) and merges project-over-global:
//   daidentity:
//     name: Echo
//     voices: { main: { voiceId: en-GB-LibbyNeural } }
//     startupCatchphrases: ["Echo online."]
// Unset keys fall through to global config, then to the env-based config.

function parseYaml(raw: string): unknown {
  return (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(raw);
}

function readYamlDaidentity(
  path: string,
  readFile: (path: string) => string | null,
): Record<string, unknown> | null {
  const raw = readFile(path);
  if (!raw) return null;
  try {
    const doc = parseYaml(raw) as Record<string, unknown> | null;
    const d = doc?.daidentity;
    return d && typeof d === "object" && !Array.isArray(d) ? d : null;
  } catch {
    return null;
  }
}

function ompAgentDir(home: string): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent");
}

/** Project `.omp/config.yml` over `~/.omp/agent/config.yml`, then env. */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = readTextFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = readYamlDaidentity(join(ompAgentDir(home), "config.yml"), readFile);
  const project = cwd ? readYamlDaidentity(join(cwd, ".omp", "config.yml"), readFile) : null;
  return mergeDaidentity(project, global);
}

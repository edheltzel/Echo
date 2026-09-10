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

export interface OmpVoiceConfig extends BaseVoiceConfig {
  endpoint: string;
  title: string;
  voiceEnabled: boolean;
  greetOnSessionStart: boolean;
  speakCompletions: boolean;
  suppressInSubagents: boolean;
}

// Default greeting pool lives in @echo/shared/greeting.ts (nameless unless sayName).

export function loadOmpVoiceConfig(env: Record<string, string | undefined> = loadEchoConfiguration()): OmpVoiceConfig {
  // Same canonical config.json values as the Pi adapter. Legacy ATLAS_VOICE_*
  // process values remain deprecated fallbacks. omp defaults to persona "omp"
  // and shares Pi's "pi" voice mapping unless a project identity overrides it.
  const catchphraseOverride = env.ECHO_VOICE_CATCHPHRASE ?? env.ATLAS_VOICE_CATCHPHRASE;
  const sayName = booleanEnv(env.ECHO_VOICE_SAY_NAME, false);
  return {
    endpoint: resolveNotifyUrl(env),
    title: env.ECHO_VOICE_TITLE ?? env.ATLAS_VOICE_TITLE ?? "omp Notification",
    startupCatchphrases: catchphraseOverride !== undefined ? [catchphraseOverride] : defaultStartupGreetings(sayName),
    personaName: env.ECHO_VOICE_PERSONA_NAME ?? env.ATLAS_VOICE_PERSONA_NAME ?? "omp",
    sayName,
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

function defaultReadFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

// Parse YAML via Bun's native parser (Bun.YAML, available in Bun >= 1.2). Cast
// because the installed @types/bun may predate the typing.
function parseYaml(raw: string): unknown {
  return (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(raw);
}

/** Parse an omp YAML config file and return its `daidentity` block (or null). */
function readDaidentity(
  path: string,
  readFile: (path: string) => string | null,
): Record<string, any> | null {
  const raw = readFile(path);
  if (!raw) return null;
  try {
    const doc = parseYaml(raw) as Record<string, any> | null;
    const d = doc?.daidentity;
    return d && typeof d === "object" ? (d as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * omp's global agent dir. Honors omp's own `PI_CODING_AGENT_DIR` override (it
 * relocates `~/.omp/agent`), so Echo reads the same global config omp does - and
 * so tests can point it at a scratch dir for hermetic isolation.
 */
function ompAgentDir(home: string): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(home, ".omp", "agent");
}

/**
 * Host-specific: omp's YAML `.omp/config.yml` paths, not a shared helper.
 * Project `<cwd>/.omp/config.yml` over global `~/.omp/agent/config.yml`,
 * project wins per key (same daidentity shape the Claude Code and Pi adapters read).
 * Returns null when neither file contributes a persona field.
 */
export function loadProjectPersona(
  cwd: string | undefined,
  readFile: (path: string) => string | null = defaultReadFile,
  home: string = homedir(),
): EchoPersonaOverride | null {
  const global = readDaidentity(join(ompAgentDir(home), "config.yml"), readFile);
  const project = cwd ? readDaidentity(join(cwd, ".omp", "config.yml"), readFile) : null;
  if (!global && !project) return null;

  // Per-key resolution: project wins, else global. Voice supports the nested
  // `voices.main.voiceId` shape (and a flat `voiceId`), matching the other adapters.
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

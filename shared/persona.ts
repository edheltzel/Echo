import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_PERSONA_GREETINGS } from "./greeting.ts";
import { loadEchoConfiguration } from "./echo-env.ts";

/** Project/global daidentity fields that can overlay env-based adapter config. */
export interface EchoPersonaOverride {
  personaName?: string;
  voiceId?: string;
  startupCatchphrases?: string[];
}

/** Adapter config fields `applyPersonaOverride` is allowed to replace. */
export interface PersonaFields {
  personaName: string;
  voiceId?: string;
  startupCatchphrases: string[];
}

export function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/**
 * Overlay a daidentity onto env-based adapter config. Set override keys win;
 * unset keys keep the base (env / adapter default).
 */
export function applyPersonaOverride<T extends PersonaFields>(
  base: T,
  override: EchoPersonaOverride | null,
): T {
  if (!override) return base;
  const startupCatchphrases = override.startupCatchphrases
    ?? (override.personaName ? DEFAULT_PERSONA_GREETINGS : base.startupCatchphrases);
  return {
    ...base,
    personaName: override.personaName ?? base.personaName,
    voiceId: override.voiceId ?? base.voiceId,
    startupCatchphrases,
  };
}

export function readTextFile(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Parse a JSON settings file and return its `daidentity` object, or null. */
export function parseJsonDaidentity(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    const d = json?.daidentity;
    return d && typeof d === "object" && !Array.isArray(d) ? d as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function voiceOf(d: Record<string, unknown> | null): unknown {
  if (!d) return undefined;
  const voices = d.voices;
  if (voices && typeof voices === "object" && !Array.isArray(voices)) {
    const main = (voices as Record<string, unknown>).main;
    if (main && typeof main === "object" && !Array.isArray(main)) {
      const nested = (main as Record<string, unknown>).voiceId;
      if (nested != null) return nested;
    }
  }
  return d.voiceId;
}

/** Project daidentity wins per key over global; empty result is null. */
export function mergeDaidentity(
  project: Record<string, unknown> | null,
  global: Record<string, unknown> | null,
): EchoPersonaOverride | null {
  if (!global && !project) return null;
  const name = project?.name ?? global?.name;
  const voiceId = voiceOf(project) ?? voiceOf(global);
  const rawPhrases = project?.startupCatchphrases ?? global?.startupCatchphrases;
  const phrases = Array.isArray(rawPhrases)
    ? rawPhrases.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : undefined;

  const override: EchoPersonaOverride = {};
  if (typeof name === "string" && name.trim()) override.personaName = name.trim();
  if (typeof voiceId === "string" && voiceId.trim()) override.voiceId = voiceId.trim();
  if (phrases && phrases.length > 0) override.startupCatchphrases = phrases;
  return Object.keys(override).length > 0 ? override : null;
}

/** Headless / json / print runs stay silent. Used by Pi and omp. */
export interface RunContext {
  mode?: string;
  hasUI?: boolean;
}

export function shouldSuppressVoice(
  ctx: RunContext = {},
  env: Record<string, string | undefined> = loadEchoConfiguration(),
): boolean {
  if (booleanEnv(env.ECHO_VOICE_SUPPRESS ?? env.ATLAS_VOICE_SUPPRESS, false)) return true;
  if (ctx.hasUI === false) return true;
  if (ctx.mode === "json" || ctx.mode === "print") return true;
  return false;
}

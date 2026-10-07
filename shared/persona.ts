// Host-neutral persona overlay + subagent suppression, shared by Pi and omp.
// Host config paths and file formats stay in each adapter.

import { resolvePersonaStartupGreetings } from "./greeting.ts";
import { loadEchoConfiguration } from "./echo-env.ts";

/** Project/global daidentity fields that can overlay env-based adapter config. */
export interface EchoPersonaOverride {
  personaName?: string;
  voiceId?: string;
  startupCatchphrases?: string[];
  sayName?: boolean;
}

/** Adapter config fields `applyPersonaOverride` is allowed to replace. */
export interface BaseVoiceConfig {
  personaName: string;
  sayName: boolean;
  voiceId?: string;
  startupCatchphrases: string[];
}

/**
 * Adapter env-string boolean grammar. Narrower than `parseEchoBoolean`
 * (string | undefined only; no y/n/empty/boolean), kept distinct so the
 * move is not a behavior change.
 */
export function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

/** Overlay a daidentity onto env-based adapter config. Set override keys win. */
export function applyPersonaOverride<T extends BaseVoiceConfig>(
  base: T,
  override: EchoPersonaOverride | null,
): T {
  if (!override) return base;
  const sayName = override.sayName ?? base.sayName;
  const startupCatchphrases = resolvePersonaStartupGreetings(
    base.startupCatchphrases,
    override.startupCatchphrases,
    sayName,
  );
  return {
    ...base,
    personaName: override.personaName ?? base.personaName,
    voiceId: override.voiceId ?? base.voiceId,
    sayName,
    startupCatchphrases,
  };
}

/** Subset of a host ExtensionContext needed to decide suppression. */
export interface RunContext {
  mode?: string;
  hasUI?: boolean;
}

/**
 * Headless / json / print runs stay silent so child agents do not flood audio.
 * Hosts that spawn children without UI set hasUI=false; tui and rpc keep UI.
 */
export function shouldSuppressVoice(
  ctx: RunContext = {},
  env: Record<string, string | undefined> = loadEchoConfiguration(),
): boolean {
  if (booleanEnv(env.ECHO_VOICE_SUPPRESS ?? env.ATLAS_VOICE_SUPPRESS, false)) return true;
  if (ctx.hasUI === false) return true;
  if (ctx.mode === "json" || ctx.mode === "print") return true;
  return false;
}

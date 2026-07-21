/**
 * Central Identity Loader
 * Single source of truth for DA (Digital Assistant) and Principal identity
 *
 * Reads from settings.json - the programmatic way, not markdown parsing.
 * All hooks and tools should import from here.
 *
 * LAYERED RESOLUTION (per key, tightest scope wins):
 *   1. $projectDir/.claude/settings.local.json  (gitignored, per-machine)
 *   2. $projectDir/.claude/settings.json         (checked in, shared)
 *   3. ~/.claude/settings.json                   (global)
 *   4. neutral defaults
 * A project's `daidentity` overrides the global one PER KEY (deep merge, local
 * leaf wins) — the same "tightest source wins per key" precedence shared/echo-env.ts
 * commits to. So a repo can set just its name + voice and inherit everything else
 * from global. Arrays (startupCatchphrases) are atomic: a local array replaces the
 * global one only when present. projectDir defaults to CLAUDE_PROJECT_DIR (set for
 * every hook, incl. Stop, and pointing at the project root).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const HOME = process.env.HOME!;

// Default identity (fallback if settings.json doesn't have identity section).
// Neutral on purpose: never assume the user's DA name — they configure it in settings.json.
const DEFAULT_IDENTITY = {
  name: 'Assistant',
  fullName: 'Assistant',
  displayName: 'Assistant',
  mainDAVoiceID: '',
  color: '#3B82F6',
};

const DEFAULT_PRINCIPAL = {
  name: 'User',
  pronunciation: '',
  timezone: 'UTC',
};

export interface VoiceProsody {
  stability: number;
  similarity_boost: number;
  style: number;
  speed: number;
  use_speaker_boost: boolean;
}

export interface VoicePersonality {
  baseVoice: string;
  enthusiasm: number;
  energy: number;
  expressiveness: number;
  resilience: number;
  composure: number;
  optimism: number;
  warmth: number;
  formality: number;
  directness: number;
  precision: number;
  curiosity: number;
  playfulness: number;
}

export interface Identity {
  name: string;
  fullName: string;
  displayName: string;
  mainDAVoiceID: string;
  color: string;
  voice?: VoiceProsody;
  personality?: VoicePersonality;
  /** Startup catchphrase pool (raw; callers apply the `{name}` substitution). */
  startupCatchphrases?: string[];
  /** Single startup catchphrase (legacy; used when the array is empty). */
  startupCatchphrase?: string;
  /** True when a project-scope layer set the persona name/displayName (a repo renamed the DA). */
  personaFromProject?: boolean;
  /** True when a project-scope layer set its own startupCatchphrases array. */
  catchphrasesFromProject?: boolean;
}

export interface Principal {
  name: string;
  pronunciation: string;
  timezone: string;
}

export interface Settings {
  daidentity?: Partial<Identity>;
  principal?: Partial<Principal>;
  env?: Record<string, string>;
  [key: string]: unknown;
}

// Merged-settings cache, keyed by `${home}\0${projectDir}` — each hook is a fresh
// short-lived process with a stable project dir, so per-key caching is safe.
const settingsCache = new Map<string, Settings>();

/** Read+parse a single settings file; null when missing or malformed. */
function readSettingsFile(path: string): Settings | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as Settings;
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` onto `base`, per leaf. Scalars and arrays from `override`
 * replace `base` wholesale (arrays are atomic — so a local catchphrase array
 * replaces the global one only when present). Nested plain objects merge
 * recursively. `undefined` values in `override` never clobber `base`.
 */
function deepMerge(base: any, override: any): any {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

/**
 * The active project directory. Defaults to CLAUDE_PROJECT_DIR (set for every
 * hook, incl. Stop, pointing at the project root). Empty string → global only.
 */
function resolveProjectDir(projectDir?: string): string {
  return projectDir ?? process.env.CLAUDE_PROJECT_DIR ?? '';
}

/**
 * Load settings with layered precedence (global → project → project.local),
 * deep-merged per key. Cached by (home, projectDir).
 */
function loadSettings(projectDir?: string, home: string = HOME): Settings {
  const dir = resolveProjectDir(projectDir);
  const cacheKey = `${home}\0${dir}`;
  const cached = settingsCache.get(cacheKey);
  if (cached) return cached;

  // Lowest → highest priority; fold with deepMerge so tighter scopes win per key.
  const layers: Array<Settings | null> = [
    readSettingsFile(join(home, '.claude', 'settings.json')),
  ];
  if (dir) {
    layers.push(readSettingsFile(join(dir, '.claude', 'settings.json')));
    layers.push(readSettingsFile(join(dir, '.claude', 'settings.local.json')));
  }

  const merged = layers.reduce<Settings>(
    (acc, layer) => (layer ? deepMerge(acc, layer) : acc),
    {},
  );
  settingsCache.set(cacheKey, merged);
  return merged;
}

/**
 * The daidentity block from the PROJECT-scope layers only (project → project.local),
 * with no global layer. Used to tell what a repo set for itself, so a project persona
 * name can override an inherited global `displayName` and drive the startup greeting.
 */
function loadProjectDaidentity(projectDir?: string, home: string = HOME): Record<string, any> {
  const dir = resolveProjectDir(projectDir);
  if (!dir) return {};
  const merged = [
    readSettingsFile(join(dir, '.claude', 'settings.json')),
    readSettingsFile(join(dir, '.claude', 'settings.local.json')),
  ].reduce<Settings>((acc, layer) => (layer ? deepMerge(acc, layer) : acc), {} as Settings);
  return (merged.daidentity as Record<string, any>) || {};
}

/**
 * Get DA (Digital Assistant) identity, resolved with layered precedence
 * (project.local → project → global → defaults), per key.
 */
export function getIdentity(projectDir?: string, home: string = HOME): Identity {
  const settings = loadSettings(projectDir, home);

  // Prefer settings.daidentity, fall back to env.DA for backward compat
  const daidentity = settings.daidentity || {};
  const envDA = settings.env?.DA;

  // What THIS repo set for itself (no global) — for persona-name precedence + greeting policy.
  const projectDai = loadProjectDaidentity(projectDir, home);
  const personaFromProject = typeof projectDai.name === 'string' || typeof projectDai.displayName === 'string';
  const catchphrasesFromProject = Array.isArray(projectDai.startupCatchphrases);

  // Support both old (daidentity.voice) and new (daidentity.voices.main) structures
  const voices = (daidentity as any).voices || {};
  const voiceConfig = voices.main || (daidentity as any).voice;

  const catchphrases = (daidentity as any).startupCatchphrases;

  return {
    name: daidentity.name || envDA || DEFAULT_IDENTITY.name,
    fullName: daidentity.fullName || daidentity.name || envDA || DEFAULT_IDENTITY.fullName,
    // A repo that sets its own persona name (but not displayName) must drive the spoken
    // name — so the project's name/displayName wins over an inherited global displayName.
    displayName: projectDai.displayName || projectDai.name
      || daidentity.displayName || daidentity.name || envDA || DEFAULT_IDENTITY.displayName,
    mainDAVoiceID: voiceConfig?.voiceId || (daidentity as any).voiceId || daidentity.mainDAVoiceID || DEFAULT_IDENTITY.mainDAVoiceID,
    color: daidentity.color || DEFAULT_IDENTITY.color,
    voice: voiceConfig as VoiceProsody | undefined,
    personality: (daidentity as any).personality as VoicePersonality | undefined,
    startupCatchphrases: Array.isArray(catchphrases) ? catchphrases : undefined,
    startupCatchphrase: (daidentity as any).startupCatchphrase as string | undefined,
    personaFromProject,
    catchphrasesFromProject,
  };
}

/**
 * Get Principal (human owner) identity, resolved with layered precedence.
 */
export function getPrincipal(projectDir?: string, home: string = HOME): Principal {
  const settings = loadSettings(projectDir, home);

  // Prefer settings.principal, fall back to env.PRINCIPAL for backward compat
  const principal = settings.principal || {};
  const envPrincipal = settings.env?.PRINCIPAL;

  return {
    name: principal.name || envPrincipal || DEFAULT_PRINCIPAL.name,
    pronunciation: principal.pronunciation || DEFAULT_PRINCIPAL.pronunciation,
    timezone: principal.timezone || DEFAULT_PRINCIPAL.timezone,
  };
}

/**
 * Clear cache (useful for testing or when settings.json changes)
 */
export function clearCache(): void {
  settingsCache.clear();
}

/**
 * Get just the DA name (convenience function)
 */
export function getDAName(): string {
  return getIdentity().name;
}

/**
 * Get just the Principal name (convenience function)
 */
export function getPrincipalName(): string {
  return getPrincipal().name;
}

/**
 * Get just the voice ID (convenience function)
 */
export function getVoiceId(): string {
  return getIdentity().mainDAVoiceID;
}

/**
 * Get Algorithm-specific voice config (for phase announcements).
 * Falls back to main voice if algorithm voice not configured.
 */
export function getAlgorithmVoice(): { voiceId: string; voiceName?: string } {
  const settings = loadSettings();
  const voices = (settings.daidentity as any)?.voices || {};
  const algVoice = voices.algorithm || voices.main;
  return {
    voiceId: algVoice?.voiceId || getVoiceId(),
    voiceName: algVoice?.voiceName,
  };
}

/**
 * Get the full settings object (for advanced use)
 */
export function getSettings(): Settings {
  return loadSettings();
}

/**
 * Get the default identity (for documentation/testing)
 */
export function getDefaultIdentity(): Identity {
  return { ...DEFAULT_IDENTITY };
}

/**
 * Get the default principal (for documentation/testing)
 */
export function getDefaultPrincipal(): Principal {
  return { ...DEFAULT_PRINCIPAL };
}

/**
 * Get voice prosody settings (convenience function) - legacy ElevenLabs
 */
export function getVoiceProsody(): VoiceProsody | undefined {
  return getIdentity().voice;
}

/**
 * Get voice personality settings (convenience function) - Qwen3-TTS
 */
export function getVoicePersonality(): VoicePersonality | undefined {
  return getIdentity().personality;
}

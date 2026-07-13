// =============================================================================
// Environment parsing helpers — host-neutral
// =============================================================================

import { loadEchoEnvironment } from "../shared/echo-env";

// Parse a numeric environment variable, falling back to `fallback` when the
// value is missing, non-numeric, or below `min`. Guards against degenerate
// configs (NaN / negative / zero) that would otherwise silently break timeouts,
// retry counts, or breaker thresholds — e.g. a NaN timeout → setTimeout(fn, 0)
// firing instantly, or a NaN retry count zeroing the retry loop and reporting a
// false success for a synthesis that never ran (issue #25, masks real outages).
export function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

// --- Echo env-file resolution (import-pure) ---------------------------------
//
// The daemon reads config from the user-owned env files (ECHO_ENV_PATHS, then
// ~/.config/echo/.env, ~/.config/voicesystem/.env, ~/.env — first file wins
// per key) with a real process value always beating every file.
//
// IMPORT-PURITY CONTRACT: resolving config must NEVER write to process.env.
// Host adapters (and their tests) read identity config (ECHO_VOICE_*) from
// process.env; the daemon historically hydrated process.env from the files at
// module load, which leaked the operator's identity (e.g. a configured
// persona name) into any same-process adapter code loaded later — adapter
// persona tests then saw the operator's name instead of their default, an
// AGENTS.md #47 class file-order hazard. Core code therefore reads config
// through resolveEchoEnv, which layers the (lazily loaded, cached) file
// values UNDER the live process environment without mutating it.

let fileEnv: Record<string, string | undefined> | undefined;

// File layer only: delegate the file walk + per-key precedence to the shared
// loader (the single home for that contract — AGENTS.md), seeded with just
// the env-path config so no live process values leak into the cached layer.
function loadEchoFileEnv(): Record<string, string | undefined> {
  const seed: Record<string, string | undefined> = {};
  if (process.env.ECHO_ENV_PATHS) seed.ECHO_ENV_PATHS = process.env.ECHO_ENV_PATHS;
  if (process.env.VOICESYSTEM_ENV_PATHS) seed.VOICESYSTEM_ENV_PATHS = process.env.VOICESYSTEM_ENV_PATHS;
  return loadEchoEnvironment(seed);
}

/**
 * Resolve one config key with the daemon's precedence — live process value
 * first, then the first configured env file per key — without mutating
 * process.env. File contents are read once per process and cached.
 */
export function resolveEchoEnv(key: string): string | undefined {
  const live = process.env[key];
  if (live) return live;
  fileEnv ??= loadEchoFileEnv();
  return fileEnv[key];
}

/**
 * Pin (or clear) the cached file layer. Tests that assert built-in DEFAULTS
 * pass `{}` so the operator's real env files cannot leak into expectations;
 * `undefined` restores lazy loading from the real files.
 */
export function primeEchoFileEnv(env: Record<string, string | undefined> | undefined): void {
  fileEnv = env;
}

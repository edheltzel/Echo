// =============================================================================
// Environment parsing helpers — host-neutral
// =============================================================================

import { loadEchoConfigurationWithStatus, type EchoConfigStatus } from "../shared/echo-env";

// Parse a numeric environment variable, falling back to `fallback` when the
// value is missing, non-numeric, below `min`, or above `max`. Guards against
// degenerate configs (NaN / negative / zero / out of range) that would otherwise
// silently break timeouts, retry counts, or breaker thresholds — e.g. a NaN
// timeout → setTimeout(fn, 0) firing instantly, or a NaN retry count zeroing the
// retry loop and reporting a false success for a synthesis that never ran (issue
// #25, masks real outages). `max` matters for the listen port, where an
// out-of-range value would throw inside Bun.serve and crash-loop the daemon.
export function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number = Number.POSITIVE_INFINITY,
): number {
  const n = parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// --- Echo configuration resolution (import-pure) ----------------------------
//
// The daemon reads config from ~/.config/echo/config.json, with a real process
// value always beating the JSON file. Legacy dotenv files are a lower-priority
// migration fallback; see shared/echo-env.ts.
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
let fileConfigStatus: EchoConfigStatus | undefined;

const NO_CONFIG_STATUS: EchoConfigStatus = { path: "", present: false, ignored: [], errors: [] };

// File layer only: delegate config-file and migration fallback resolution to the
// shared loader (the single home for that contract), seeded with just path
// selection values so no live process values leak into the cached layer.
function loadEchoFileEnv(): Record<string, string | undefined> {
  const seed: Record<string, string | undefined> = {};
  if (process.env.ECHO_ENV_PATHS) seed.ECHO_ENV_PATHS = process.env.ECHO_ENV_PATHS;
  if (process.env.ECHO_CONFIG_FILE) seed.ECHO_CONFIG_FILE = process.env.ECHO_CONFIG_FILE;
  const { env, config } = loadEchoConfigurationWithStatus(seed);
  fileConfigStatus = config;
  return env;
}

/**
 * Resolve one config key with the daemon's precedence — live process value
 * first, then config.json, then the legacy dotenv fallback — without mutating
 * process.env. File contents are read once per process and cached.
 */
export function resolveEchoEnv(key: string): string | undefined {
  const live = process.env[key];
  if (live !== undefined) return live;
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
  fileConfigStatus = env === undefined ? undefined : NO_CONFIG_STATUS;
}

/**
 * What config.json contributed to the cached file layer, including any keys
 * that were dropped for failing validation. Reported by GET /health so an
 * ignored key is visible without reading the daemon log.
 */
export function echoConfigStatus(): EchoConfigStatus {
  fileEnv ??= loadEchoFileEnv();
  return fileConfigStatus ?? NO_CONFIG_STATUS;
}

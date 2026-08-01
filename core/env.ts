// =============================================================================
// Environment parsing helpers - host-neutral
// =============================================================================

import { loadEchoConfigurationWithStatus, type EchoConfigStatus } from "../shared/echo-env";

// Parse a numeric environment variable, falling back to `fallback` when the
// value is missing, non-numeric, below `min`, or above `max`. Guards against
// degenerate configs (NaN / negative / zero / out of range) that would otherwise
// silently break timeouts, retry counts, or breaker thresholds - e.g. a NaN
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
// The daemon reads config from ~/.config/echo/config.json first. Real process
// values remain a deprecated one-release fallback, followed by legacy dotenv
// files; see shared/echo-env.ts.
//
// IMPORT-PURITY CONTRACT: resolving config must NEVER write to process.env.
// Host adapters resolve identity config (ECHO_VOICE_*) through the shared
// loader; the daemon historically hydrated process.env from files at module
// load, which leaked the operator's identity (e.g. a configured
// persona name) into any same-process adapter code loaded later - adapter
// persona tests then saw the operator's name instead of their default, an
// AGENTS.md #47 class file-order hazard. Core code therefore reads config
// through resolveEchoEnv, which reads one lazily loaded, cached resolution
// without mutating process.env.

let fileEnv: Record<string, string | undefined> | undefined;
let configuredKeys = new Set<string>();
let fileConfigStatus: EchoConfigStatus | undefined;

const NO_CONFIG_STATUS: EchoConfigStatus = {
  path: "",
  present: false,
  ignored: [],
  errors: [],
  configured: [],
  deprecatedEnvironment: [],
};

// Cache only file-backed values. config.json keys are authoritative; deprecated
// process fallbacks remain live so test harnesses and one-release compatibility
// callers can set them after core was imported without leaking them into files.
// process.env is passed for REPORTING only: the one deprecation warning and the
// GET /health status must cover the whole compatibility layer (dotenv-sourced
// keys plus the live fallbacks the daemon honors) without caching live values.
function loadEchoFileEnv(): Record<string, string | undefined> {
  const seed: Record<string, string | undefined> = {};
  if (process.env.ECHO_ENV_PATHS) seed.ECHO_ENV_PATHS = process.env.ECHO_ENV_PATHS;
  if (process.env.ECHO_CONFIG_FILE) seed.ECHO_CONFIG_FILE = process.env.ECHO_CONFIG_FILE;
  const { env, config } = loadEchoConfigurationWithStatus(seed, undefined, {
    reportEnvironment: process.env,
  });
  configuredKeys = new Set(config.configured);
  fileConfigStatus = config;
  return env;
}

/**
 * Resolve one config key with the daemon's precedence - config.json, deprecated
 * live process value, then legacy dotenv - without mutating process.env. File
 * contents and the compatibility layer are read once per process and cached.
 */
export function resolveEchoEnv(key: string): string | undefined {
  fileEnv ??= loadEchoFileEnv();
  if (configuredKeys.has(key)) return fileEnv[key];
  const live = process.env[key];
  return live !== undefined ? live : fileEnv[key];
}

/**
 * Pin (or clear) the cached file layer. Tests that model config.json use the
 * default authoritative mode; tests modeling legacy dotenv pass false so a
 * live compatibility value still wins. `undefined` restores lazy loading.
 */
export function primeEchoFileEnv(
  env: Record<string, string | undefined> | undefined,
  authoritative: boolean = true,
): void {
  fileEnv = env;
  configuredKeys = new Set(env === undefined || !authoritative ? [] : Object.keys(env));
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

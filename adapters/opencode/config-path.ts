import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const OPENCODE_GLOBAL_CONFIG_NAMES = ["opencode.jsonc", "opencode.json", "config.json"] as const;
export const OPENCODE_PROJECT_CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

function firstExisting(
  dir: string,
  names: readonly string[],
  exists: (path: string) => boolean,
): string | undefined {
  for (const name of names) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * OpenCode globalConfigFile order: opencode.jsonc, opencode.json, config.json.
 * Missing files default to opencode.jsonc. ECHO_OPENCODE_CONFIG pins an exact path.
 */
export function resolveOpenCodeConfigPath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.ECHO_OPENCODE_CONFIG) return env.ECHO_OPENCODE_CONFIG;
  const dir = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "opencode")
    : join(home, ".config", "opencode");
  return firstExisting(dir, OPENCODE_GLOBAL_CONFIG_NAMES, exists) ?? join(dir, "opencode.jsonc");
}

export function resolveProjectOpenCodeConfigPath(
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  return firstExisting(cwd, OPENCODE_PROJECT_CONFIG_NAMES, exists);
}

/** Global OpenCode plugins directory. ECHO_OPENCODE_PLUGINS_DIR pins tests. */
export function resolveOpenCodePluginsDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (env.ECHO_OPENCODE_PLUGINS_DIR) return env.ECHO_OPENCODE_PLUGINS_DIR;
  const dir = env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, "opencode")
    : join(home, ".config", "opencode");
  return join(dir, "plugins");
}

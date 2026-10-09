import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { booleanEnv } from "@echo/shared/persona.ts";

type Env = Record<string, string | undefined>;

function globalConfigDir(env: Env, home: string): string {
  return env.XDG_CONFIG_HOME ? join(env.XDG_CONFIG_HOME, "opencode") : join(home, ".config", "opencode");
}

/** `start` and each parent up to `stop` (inclusive) or the filesystem root, nearest first. */
function ancestors(start: string, stop: string | undefined): string[] {
  const dirs: string[] = [];
  for (let current = start; ; current = dirname(current)) {
    dirs.push(current);
    if (current === stop || dirname(current) === current) return dirs;
  }
}

/**
 * Global config files in OpenCode's merge order, lowest priority first
 * (config/config.ts loadGlobal: config.json < opencode.json < opencode.jsonc).
 * ECHO_OPENCODE_CONFIG pins a single file for tests.
 */
export function openCodeGlobalConfigPaths(env: Env = process.env, home: string = homedir()): string[] {
  if (env.ECHO_OPENCODE_CONFIG) return [env.ECHO_OPENCODE_CONFIG];
  const dir = globalConfigDir(env, home);
  return ["config.json", "opencode.json", "opencode.jsonc"].map((name) => join(dir, name));
}

/**
 * Every config file OpenCode merges for a session in `cwd`, lowest priority first
 * (config/config.ts + config/paths.ts): global files, OPENCODE_CONFIG, project
 * opencode.json(c) from the worktree root down to `cwd`, then `.opencode/` dirs
 * (nearest first, then ~/.opencode), then OPENCODE_CONFIG_DIR. Missing files are
 * listed too; readers skip them.
 */
export function openCodeConfigLayers(opts: {
  env?: Env;
  home?: string;
  cwd?: string;
  worktree?: string;
} = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const layers = openCodeGlobalConfigPaths(env, home);
  if (env.OPENCODE_CONFIG) layers.push(env.OPENCODE_CONFIG);

  const projectEnabled = opts.cwd !== undefined && !booleanEnv(env.OPENCODE_DISABLE_PROJECT_CONFIG, false);
  const nearestFirst = projectEnabled ? ancestors(opts.cwd!, opts.worktree) : [];
  for (const dir of nearestFirst.toReversed()) {
    layers.push(join(dir, "opencode.json"), join(dir, "opencode.jsonc"));
  }

  const dotDirs = [...nearestFirst.map((dir) => join(dir, ".opencode")), join(home, ".opencode")];
  if (env.OPENCODE_CONFIG_DIR) dotDirs.push(env.OPENCODE_CONFIG_DIR);
  for (const dir of new Set(dotDirs)) {
    layers.push(join(dir, "opencode.json"), join(dir, "opencode.jsonc"));
  }
  return layers;
}

/** Global OpenCode plugins directory. ECHO_OPENCODE_PLUGINS_DIR pins tests. */
export function resolveOpenCodePluginsDir(env: Env = process.env, home: string = homedir()): string {
  return env.ECHO_OPENCODE_PLUGINS_DIR || join(globalConfigDir(env, home), "plugins");
}

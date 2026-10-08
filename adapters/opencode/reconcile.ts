#!/usr/bin/env bun
/**
 * Idempotent reconcile-and-prune for the OpenCode adapter (#77). Echo owns two
 * symlinks: `plugins/echo-voice.ts` -> `plugin.ts` (voice) and
 * `commands/echo-mute.md` (mute). OpenCode also loads every `"plugin"` entry in
 * its global config, so an Echo `plugin.ts` entry there is a duplicate
 * registration (every line spoken twice) and is pruned. Foreign occupants are
 * fatal; dead Echo-spelled links are healed. `--check`: exit 3 = pending,
 * 0 = current, 2 = fatal.
 */

import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSON5 } from "bun";
import { applyOwnedSymlink, ownedLinkLog, planOwnedSymlink } from "@echo/shared/owned-symlink.ts";
import { resolveOpenCodeConfigPath, resolveOpenCodePluginsDir } from "./config-path.ts";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const ECHO_PLUGIN_RE = /(^|\/)adapters\/opencode\/plugin\.ts$/;

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function commandsDir(): string {
  if (process.env.ECHO_OPENCODE_COMMANDS_DIR?.trim()) return process.env.ECHO_OPENCODE_COMMANDS_DIR.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "opencode", "commands") : join(homedir(), ".config", "opencode", "commands");
}

function sourceOf(relative: string): string {
  try {
    return realpathSync(join(ADAPTER_DIR, relative));
  } catch {
    fatal(`the OpenCode adapter file is missing at ${join(ADAPTER_DIR, relative)}`);
  }
}

const links = [
  {
    filename: "echo-voice.ts",
    plan: planOwnedSymlink({
      destination: join(resolveOpenCodePluginsDir(), "echo-voice.ts"),
      source: sourceOf("plugin.ts"),
      isEchoSpelling: (target) => ECHO_PLUGIN_RE.test(target),
      fatal,
    }),
  },
  {
    filename: "echo-mute.md",
    plan: planOwnedSymlink({
      destination: join(commandsDir(), "echo-mute.md"),
      source: sourceOf("commands/echo-mute.md"),
      isEchoSpelling: (target) => /(^|\/)adapters\/opencode\/commands\/echo-mute\.md$/.test(target),
      fatal,
    }),
  },
];

// Config `"plugin"` entries that load Echo's plugin.ts (any clone, `file://` or bare path).
const configPath = resolveOpenCodeConfigPath();
let configText: string | null = null;
let config: Record<string, unknown> | null = null;
let staleEntries: string[] = [];
if (existsSync(configPath)) {
  configText = readFileSync(configPath, "utf8");
  try {
    config = JSON5.parse(configText) as Record<string, unknown>;
  } catch (error) {
    fatal(`could not parse ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const plugins = Array.isArray(config?.plugin) ? (config.plugin as unknown[]) : [];
  staleEntries = plugins.filter(
    (entry): entry is string => typeof entry === "string" && ECHO_PLUGIN_RE.test(entry.replace(/^file:\/\//, "")),
  );
}
if (staleEntries.length > 0) {
  try {
    JSON.parse(configText!);
  } catch {
    // Rewriting JSONC would drop the operator's comments.
    fatal(
      `${configPath} lists Echo's plugin (${staleEntries.join(", ")}), which loads it twice next to `
        + `plugins/echo-voice.ts. Remove that "plugin" entry by hand; Echo will not rewrite a JSONC file.`,
    );
  }
}

const changed = links.some(({ plan }) => plan.kind !== "current") || staleEntries.length > 0;
const log = links.map(({ plan, filename }) => ownedLinkLog(plan, filename));
for (const entry of staleEntries) log.push(`- ${configPath} "plugin" -= ${entry} (duplicate of echo-voice.ts)`);

if (CHECK_ONLY) {
  log.push(
    changed
      ? "preflight passed - OpenCode registration would be updated"
      : "preflight passed - OpenCode registration already current",
  );
  console.log(log.join("\n"));
  process.exit(changed ? 3 : 0);
}

for (const { plan } of links) applyOwnedSymlink(plan);
if (staleEntries.length > 0) {
  // Write through a symlinked config (dotfiles) and keep a backup, as the Pi reconciler does.
  const realPath = realpathSync(configPath);
  const backup = `${realPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const temp = `${realPath}.tmp-${process.pid}`;
  copyFileSync(realPath, backup);
  config!.plugin = (config!.plugin as unknown[]).filter((entry) => !staleEntries.includes(entry as string));
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n");
  renameSync(temp, realPath);
  log.push(`OpenCode config pruned (backup: ${backup})`);
}
log.push(`OpenCode registration ${changed ? "updated" : "already current"}`);
console.log(log.join("\n"));

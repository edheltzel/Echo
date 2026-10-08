#!/usr/bin/env bun
/**
 * Idempotent reconcile-and-prune for the OpenCode adapter (#77). Echo owns three
 * symlinks: `plugins/echo-voice.ts` -> `plugin.ts` (voice), `commands/echo-mute.md`
 * (mute), and `commands/echo-mode.md` (mode). OpenCode also loads every `"plugin"` entry in
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
import { openCodeGlobalConfigPaths, resolveOpenCodePluginsDir } from "./config-path.ts";

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

function commandLink(filename: "echo-mute.md" | "echo-mode.md") {
  const rel = `adapters/opencode/commands/${filename}`;
  return {
    filename,
    plan: planOwnedSymlink({
      destination: join(commandsDir(), filename),
      source: sourceOf(`commands/${filename}`),
      isEchoSpelling: (target: string) => target === rel || target.endsWith(`/${rel}`),
      fatal,
    }),
  };
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
  commandLink("echo-mute.md"),
  commandLink("echo-mode.md"),
];

// Config `"plugin"` entries that load Echo's plugin.ts: any clone, `file://` or bare
// path, and OpenCode's tuple form `[spec, options]`.
function echoPluginSpec(entry: unknown): string | null {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec === "string" && ECHO_PLUGIN_RE.test(spec.replace(/^file:\/\//, "")) ? spec : null;
}

// OpenCode merges config.json < opencode.json < opencode.jsonc and a later array
// replaces an earlier one, so the global plugin list is the highest-priority
// file's `plugin` key. Only that file can load Echo twice; a shadowed entry is inert.
let configPath = "";
let configText: string | null = null;
let config: Record<string, unknown> | null = null;
let staleSpecs: string[] = [];
const configLog: string[] = [];
for (const candidate of openCodeGlobalConfigPaths().toReversed()) {
  if (!existsSync(candidate)) continue;
  const text = readFileSync(candidate, "utf8");
  // OpenCode treats an empty file as `{}`.
  if (!text.trim()) continue;
  let parsed: unknown;
  try {
    parsed = JSON5.parse(text);
  } catch (error) {
    // Not Echo's file to repair: report it and keep going rather than block install.
    configLog.push(
      `! ${candidate} does not parse (${error instanceof Error ? error.message : String(error)}); duplicate-plugin check skipped for it`,
    );
    continue;
  }
  if (typeof parsed !== "object" || parsed === null || !("plugin" in parsed)) continue;
  configPath = candidate;
  configText = text;
  config = parsed as Record<string, unknown>;
  const plugins = Array.isArray(config.plugin) ? (config.plugin as unknown[]) : [];
  staleSpecs = plugins.map(echoPluginSpec).filter((spec): spec is string => spec !== null);
  break;
}
if (staleSpecs.length > 0) {
  try {
    JSON.parse(configText!);
  } catch {
    // Rewriting JSONC would drop the operator's comments.
    fatal(
      `${configPath} lists Echo's plugin (${staleSpecs.join(", ")}), which loads it twice next to `
        + `plugins/echo-voice.ts. Remove that "plugin" entry by hand; Echo will not rewrite a JSONC file.`,
    );
  }
}

const changed = links.some(({ plan }) => plan.kind !== "current") || staleSpecs.length > 0;
const log = [...links.map(({ plan, filename }) => ownedLinkLog(plan, filename)), ...configLog];
for (const spec of staleSpecs) log.push(`- ${configPath} "plugin" -= ${spec} (duplicate of echo-voice.ts)`);

if (CHECK_ONLY) {
  log.push(
    changed
      ? "preflight passed - OpenCode registration would be updated"
      : "preflight passed - OpenCode registration already current",
  );
  console.log(log.join("\n"));
  process.exit(changed ? 3 : 0);
}

if (staleSpecs.length > 0) {
  // Write through a symlinked config (dotfiles) and keep a backup, as the Pi reconciler does.
  const realPath = realpathSync(configPath);
  const backup = `${realPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const temp = `${realPath}.tmp-${process.pid}`;
  copyFileSync(realPath, backup);
  config!.plugin = (config!.plugin as unknown[]).filter((entry) => echoPluginSpec(entry) === null);
  writeFileSync(temp, JSON.stringify(config, null, 2) + "\n");
  renameSync(temp, realPath);
  log.push(`OpenCode config pruned (backup: ${backup})`);
}
// Prune first: if the config write fails, no new symlink sits beside the old entry.
for (const { plan } of links) applyOwnedSymlink(plan);
log.push(`OpenCode registration ${changed ? "updated" : "already current"}`);
console.log(log.join("\n"));

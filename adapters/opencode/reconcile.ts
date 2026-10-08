#!/usr/bin/env bun
/**
 * Idempotent reconcile-and-prune for the OpenCode adapter (#77). Echo owns two
 * symlinks and nothing else: `plugins/echo-voice.ts` -> `plugin.ts` (voice) and
 * `commands/echo-mute.md` (mute). Foreign occupants are fatal; dead Echo-spelled
 * links are healed. `--check`: exit 3 = pending, 0 = current, 2 = fatal.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOwnedSymlink, ownedLinkLog, planOwnedSymlink } from "@echo/shared/owned-symlink.ts";
import { resolveOpenCodePluginsDir } from "./config-path.ts";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));

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
      isEchoSpelling: (target) => /(^|\/)adapters\/opencode\/plugin\.ts$/.test(target),
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

const changed = links.some(({ plan }) => plan.kind !== "current");
const log = links.map(({ plan, filename }) => ownedLinkLog(plan, filename));

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
log.push(`OpenCode registration ${changed ? "updated" : "already current"}`);
console.log(log.join("\n"));

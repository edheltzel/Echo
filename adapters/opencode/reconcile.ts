#!/usr/bin/env bun

/**
 * Idempotent reconcile-and-prune for OpenCode `/echo-mute` (#77).
 *
 * Echo owns exactly one symlink under the OpenCode commands directory:
 *   $XDG_CONFIG_HOME/opencode/commands/echo-mute.md
 *   (default ~/.config/opencode/commands/echo-mute.md)
 *
 * Sibling command files are never rewritten or pruned. This adapter does not
 * register OpenCode lifecycle hooks or speak through /notify.
 *
 * --check: exit 0 current, 3 pending, 2 fatal ownership conflict.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyOwnedSymlink, ownedLinkLog, planOwnedSymlink } from "@echo/shared/owned-symlink.ts";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(ADAPTER_DIR, "commands", "echo-mute.md");
const FILENAME = "echo-mute.md";

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function resolveCommandsDir(): string {
  if (process.env.ECHO_OPENCODE_COMMANDS_DIR?.trim()) {
    return process.env.ECHO_OPENCODE_COMMANDS_DIR.trim();
  }
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) return join(xdg, "opencode", "commands");
  return join(homedir(), ".config", "opencode", "commands");
}

function canonicalSource(): string {
  try {
    return realpathSync(SOURCE);
  } catch {
    fatal(`the OpenCode mute command is missing at ${SOURCE}`);
  }
}

function isEchoMuteSpelling(target: string): boolean {
  return /(^|\/)adapters\/opencode\/commands\/echo-mute\.md$/.test(target);
}

const source = canonicalSource();
const plan = planOwnedSymlink({
  destination: join(resolveCommandsDir(), FILENAME),
  source,
  isEchoSpelling: isEchoMuteSpelling,
  fatal,
});
const changed = plan.kind !== "current";
const log = [ownedLinkLog(plan, FILENAME)];

if (CHECK_ONLY) {
  log.push(
    changed
      ? "preflight passed - OpenCode mute command would be updated"
      : "preflight passed - OpenCode mute command already current",
  );
  console.log(log.join("\n"));
  process.exit(changed ? 3 : 0);
}

applyOwnedSymlink(plan);
log.push(`OpenCode mute command ${changed ? "updated" : "already current"}`);
console.log(log.join("\n"));

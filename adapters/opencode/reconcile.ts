#!/usr/bin/env bun

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

function commandsDir(): string {
  if (process.env.ECHO_OPENCODE_COMMANDS_DIR?.trim()) return process.env.ECHO_OPENCODE_COMMANDS_DIR.trim();
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(xdg, "opencode", "commands") : join(homedir(), ".config", "opencode", "commands");
}

let source: string;
try {
  source = realpathSync(SOURCE);
} catch {
  fatal(`the OpenCode mute command is missing at ${SOURCE}`);
}

const plan = planOwnedSymlink({
  destination: join(commandsDir(), FILENAME),
  source,
  isEchoSpelling: (target) => /(^|\/)adapters\/opencode\/commands\/echo-mute\.md$/.test(target),
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

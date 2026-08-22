#!/usr/bin/env bun

/**
 * Idempotent reconcile for the Codex host adapter.
 *
 * Echo owns one identifiable command entry inside the Codex hooks document
 * (project `.codex/hooks.json` when present, else `~/.codex/hooks.json`):
 *   bun '<repo>/adapters/codex/hook.ts'
 *
 * Other hooks (Firstmate turn-end, arm checks, foreign tools) are preserved.
 *
 * --check: exit 0 current, 3 pending, 2 fatal.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = join(ADAPTER_DIR, "hook.ts");
const MARKER = "adapters/codex/hook.ts";

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function resolveHooksFile(): string {
  if (process.env.ECHO_CODEX_HOOKS_FILE?.trim()) {
    return process.env.ECHO_CODEX_HOOKS_FILE.trim();
  }
  // Prefer project hooks when running from a repo that already has them.
  const project = join(process.cwd(), ".codex", "hooks.json");
  if (existsSync(project)) return project;
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(home, "hooks.json");
}

function canonicalHookPath(): string {
  try {
    return realpathSync(HOOK_ENTRY);
  } catch {
    fatal(`the Codex hook entry is missing at ${HOOK_ENTRY}`);
  }
}

function isEchoCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(MARKER);
}

function echoHook(command: string, timeout: number) {
  return {
    type: "command",
    command,
    timeout,
  };
}

function ensureEvent(
  hooksRoot: Record<string, any>,
  event: string,
  command: string,
  timeout: number,
): boolean {
  if (!Array.isArray(hooksRoot[event])) hooksRoot[event] = [];
  const groups = hooksRoot[event] as any[];
  // Find an existing Echo command anywhere under this event.
  for (const group of groups) {
    const list = group?.hooks;
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      if (isEchoCommand(list[i]?.command)) {
        const desired = echoHook(command, timeout);
        const same =
          list[i].type === desired.type
          && list[i].command === desired.command
          && list[i].timeout === desired.timeout;
        if (same) return false;
        list[i] = desired;
        return true;
      }
    }
  }
  // Append a new group with only the Echo hook.
  groups.push({ hooks: [echoHook(command, timeout)] });
  return true;
}

function pruneStaleEcho(hooksRoot: Record<string, any>, command: string): boolean {
  let changed = false;
  for (const event of Object.keys(hooksRoot)) {
    const groups = hooksRoot[event];
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h: any) => {
        if (!isEchoCommand(h?.command)) return true;
        return h.command === command;
      });
      if (group.hooks.length !== before) changed = true;
    }
    const filtered = groups.filter((g: any) => Array.isArray(g?.hooks) && g.hooks.length > 0);
    if (filtered.length !== groups.length) {
      hooksRoot[event] = filtered;
      changed = true;
    }
  }
  return changed;
}

const hooksFile = resolveHooksFile();
const canonical = canonicalHookPath();
const command = `bun ${shellQuote(canonical)}`;
const log: string[] = [];

let doc: { hooks?: Record<string, any> } = { hooks: {} };
if (existsSync(hooksFile)) {
  try {
    doc = JSON.parse(readFileSync(hooksFile, "utf8"));
  } catch {
    fatal(`${hooksFile} is not valid JSON`);
  }
}
if (!doc.hooks || typeof doc.hooks !== "object") doc.hooks = {};

const hooksRoot = doc.hooks as Record<string, any>;
let changed = false;
changed = ensureEvent(hooksRoot, "SessionStart", command, 10) || changed;
changed = ensureEvent(hooksRoot, "Stop", command, 30) || changed;
changed = pruneStaleEcho(hooksRoot, command) || changed;

if (CHECK_ONLY) {
  if (changed) {
    console.log("pending: Codex Echo hook registration needs update");
    process.exit(3);
  }
  console.log("✓ preflight passed - Codex hooks already current");
  process.exit(0);
}

if (!changed) {
  console.log("= Codex Echo hooks already current");
  process.exit(0);
}

mkdirSync(dirname(hooksFile), { recursive: true });
const text = `${JSON.stringify(doc, null, 2)}\n`;
const tmp = `${hooksFile}.tmp-${process.pid}`;
writeFileSync(tmp, text, { mode: 0o644 });
renameSync(tmp, hooksFile);
console.log(`✓ Codex hooks updated → ${hooksFile}`);
for (const line of log) console.log(line);

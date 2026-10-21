#!/usr/bin/env bun

/**
 * Idempotent reconcile for the Empryo host adapter.
 *
 * Echo owns bun '<repo>/adapters/empryo/hook.ts' under SessionStart, Stop and
 * Notification in ~/.empryo/hooks.json (ECHO_EMPRYO_HOOKS_FILE overrides).
 * Sibling hooks are preserved, stale Echo spellings are pruned, and a symlinked
 * hooks file is edited at its target. --check: exit 0 current, 3 pending, 2 fatal.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = join(ADAPTER_DIR, "hook.ts");
const MARKER = "adapters/empryo/hook.ts";
const EVENTS: Array<{ event: string; timeout: number }> = [
  { event: "SessionStart", timeout: 10 },
  { event: "Stop", timeout: 30 },
  { event: "Notification", timeout: 10 },
];

type HookEntry = { type?: unknown; command?: unknown; timeout?: unknown; async?: unknown };
type HookGroup = { matcher?: unknown; hooks?: HookEntry[] };
type HooksDoc = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function hooksFilePath(): string {
  const override = process.env.ECHO_EMPRYO_HOOKS_FILE?.trim();
  const path = override || join(homedir(), ".empryo", "hooks.json");
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function canonicalHookPath(): string {
  try {
    return realpathSync(HOOK_ENTRY);
  } catch {
    fatal(`the Empryo hook entry is missing at ${HOOK_ENTRY}`);
  }
}

function isEchoCommand(command: unknown): boolean {
  return typeof command === "string" && command.includes(MARKER);
}

function desiredHook(command: string, timeout: number): HookEntry {
  return { type: "command", command, timeout, async: true };
}

function sameHook(a: HookEntry, b: HookEntry): boolean {
  return a.type === b.type && a.command === b.command && a.timeout === b.timeout && a.async === b.async;
}

function ensureEvent(root: Record<string, HookGroup[]>, event: string, command: string, timeout: number): boolean {
  if (!Array.isArray(root[event])) root[event] = [];
  const desired = desiredHook(command, timeout);
  for (const group of root[event]) {
    if (!Array.isArray(group?.hooks)) continue;
    const index = group.hooks.findIndex((hook) => isEchoCommand(hook?.command));
    if (index === -1) continue;
    if (sameHook(group.hooks[index]!, desired)) return false;
    group.hooks[index] = desired;
    return true;
  }
  root[event].push({ hooks: [desired] });
  return true;
}

function pruneStaleEcho(root: Record<string, HookGroup[]>, command: string): boolean {
  let changed = false;
  for (const event of Object.keys(root)) {
    const groups = root[event];
    if (!Array.isArray(groups)) continue;
    const wanted = EVENTS.some((entry) => entry.event === event);
    let keptOne = false;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((hook) => {
        if (!isEchoCommand(hook?.command)) return true;
        if (!wanted || hook.command !== command || keptOne) return false;
        keptOne = true;
        return true;
      });
      if (group.hooks.length !== before) changed = true;
    }
    const filtered = groups.filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (filtered.length !== groups.length) {
      changed = true;
      if (filtered.length === 0) delete root[event];
      else root[event] = filtered;
    }
  }
  return changed;
}

const hooksFile = hooksFilePath();
const command = `bun ${shellQuote(canonicalHookPath())}`;

let doc: HooksDoc = {};
if (existsSync(hooksFile)) {
  try {
    doc = JSON.parse(readFileSync(hooksFile, "utf8")) as HooksDoc;
  } catch {
    fatal(`${hooksFile} is not valid JSON`);
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fatal(`${hooksFile} is not a JSON object`);
}
if (!doc.hooks || typeof doc.hooks !== "object" || Array.isArray(doc.hooks)) doc.hooks = {};

const root = doc.hooks;
let changed = false;
for (const { event, timeout } of EVENTS) changed = ensureEvent(root, event, command, timeout) || changed;
changed = pruneStaleEcho(root, command) || changed;

if (CHECK_ONLY) {
  if (changed) {
    console.log("pending: Empryo Echo hook registration needs update");
    process.exit(3);
  }
  console.log("✓ preflight passed - Empryo hooks already current");
  process.exit(0);
}

if (changed) {
  mkdirSync(dirname(hooksFile), { recursive: true });
  const tmp = `${hooksFile}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, hooksFile);
  console.log(`✓ Empryo hooks updated → ${hooksFile}`);
} else {
  console.log("= Empryo Echo hooks already current");
}

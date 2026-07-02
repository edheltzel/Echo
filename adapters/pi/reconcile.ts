#!/usr/bin/env bun
// Idempotently reconciles the Pi extension registration in ~/.pi/agent/settings.json (#77):
// exactly one packages entry resolves to this repo's adapters/pi; stale */adapters/pi
// entries from a renamed or moved clone are pruned. `pi install` appends, so a directory
// rename would otherwise strand a dead entry (which fails silently) beside the new one.
// Edits through a symlinked settings.json without replacing the symlink.
// Safe to run repeatedly. Backs up the settings file before mutating.

import { copyFileSync, existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = process.env.PI_SETTINGS_PATH || join(homedir(), ".pi/agent/settings.json");
const CHECK_ONLY = process.argv.includes("--check");

if (!existsSync(SETTINGS_PATH)) {
  console.log(`= no Pi settings at ${SETTINGS_PATH} — nothing to reconcile`);
  process.exit(0);
}

type Settings = { packages?: string[]; [k: string]: unknown };
const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;
settings.packages ??= [];

// Pi resolves relative package paths against the settings file's nominal directory
// (~/.pi/agent), not the symlink target's directory — canonicalize relative to it.
const SETTINGS_DIR = dirname(SETTINGS_PATH);
const CANONICAL_DIR = realpathSync(ADAPTER_DIR);
const CANONICAL_ENTRY = relative(SETTINGS_DIR, CANONICAL_DIR);

function isAdapterPathEntry(entry: string): boolean {
  if (/^(npm|git|https?|ssh):/.test(entry)) return false;
  return /(^|\/)adapters\/pi\/?$/.test(entry);
}

function resolvesToCanonical(entry: string): boolean {
  const abs = isAbsolute(entry) ? entry : resolve(SETTINGS_DIR, entry);
  try {
    return realpathSync(abs) === CANONICAL_DIR;
  } catch {
    return false; // dead path
  }
}

let changed = false;
const log: string[] = [];
let kept = false;
const packages: string[] = [];
for (const entry of settings.packages) {
  if (!isAdapterPathEntry(entry)) {
    packages.push(entry);
    continue;
  }
  const canonical = resolvesToCanonical(entry);
  if (canonical && !kept) {
    kept = true;
    packages.push(entry);
    log.push(`= packages already has ${entry}`);
  } else if (!kept) {
    // Stale (dead or foreign) entry — replace in place so ordering survives.
    kept = true;
    packages.push(CANONICAL_ENTRY);
    changed = true;
    log.push(`~ packages: ${entry} → ${CANONICAL_ENTRY}`);
  } else {
    changed = true;
    log.push(`- packages: removed ${canonical ? "duplicate" : "stale"} ${entry}`);
  }
}
if (!kept) {
  packages.push(CANONICAL_ENTRY);
  changed = true;
  log.push(`+ packages += ${CANONICAL_ENTRY}`);
}
settings.packages = packages;

if (CHECK_ONLY) {
  log.push(changed ? "✓ preflight passed — Pi settings would be updated" : "✓ preflight passed — Pi settings already current");
  console.log(log.join("\n"));
  process.exit(0);
}

if (changed) {
  // Write through a possible symlink: atomically replace the resolved real file, so a
  // settings.json symlinked into a dotfiles repo stays a symlink.
  const realPath = realpathSync(SETTINGS_PATH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${realPath}.bak-${stamp}`;
  const temp = `${realPath}.tmp-${process.pid}`;
  copyFileSync(realPath, backup);
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(temp, realPath);
  log.push(`✓ Pi settings updated (backup: ${backup})`);
} else {
  log.push("✓ Pi settings already current — no write");
}

console.log(log.join("\n"));

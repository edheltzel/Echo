#!/usr/bin/env bun
// Idempotently reconciles the oh-my-pi extension registration (#18) per the
// reconcile-and-prune contract (#77): exactly one symlink in
// ~/.omp/agent/extensions/ points at this repo's adapters/pi directory; stale
// links whose target matches */adapters/pi but no longer resolves here (a
// renamed or moved clone) are pruned. omp discovers the directory through the
// symlink and loads the entries declared in package.json's `pi` field.
// Safe to run repeatedly. `--check` reports without mutating (exit 3 =
// changes pending, 0 = current, 2 = fatal).

import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = process.env.OMP_EXTENSIONS_DIR || join(homedir(), ".omp/agent/extensions");
const LINK_NAME = "echo-voice";
const CHECK_ONLY = process.argv.includes("--check");

const CANONICAL_DIR = realpathSync(ADAPTER_DIR);
const CANONICAL_LINK = join(EXTENSIONS_DIR, LINK_NAME);

function isAdapterPathTarget(target: string): boolean {
  return /(^|\/)adapters\/pi\/?$/.test(target);
}

function resolvesToCanonical(target: string): boolean {
  const abs = isAbsolute(target) ? target : resolve(EXTENSIONS_DIR, target);
  try {
    return realpathSync(abs) === CANONICAL_DIR;
  } catch {
    return false; // dead path
  }
}

let changed = false;
const log: string[] = [];
const actions: Array<() => void> = [];

const entries = existsSync(EXTENSIONS_DIR) ? readdirSync(EXTENSIONS_DIR) : [];
let kept = false;
for (const name of entries) {
  const entryPath = join(EXTENSIONS_DIR, name);
  if (!lstatSync(entryPath).isSymbolicLink()) {
    if (name === LINK_NAME) {
      console.error(`FATAL: ${entryPath} exists but is not a symlink — refusing to replace it`);
      process.exit(2);
    }
    continue; // someone else's extension file/dir
  }
  const target = readlinkSync(entryPath);
  const canonical = resolvesToCanonical(target);
  if (!canonical && !isAdapterPathTarget(target)) {
    if (name === LINK_NAME) {
      console.error(`FATAL: ${entryPath} is a symlink to unrelated ${target} — refusing to replace it`);
      process.exit(2);
    }
    continue; // unrelated symlink
  }
  if (canonical && !kept && name === LINK_NAME) {
    kept = true;
    log.push(`= extensions already has ${LINK_NAME} → ${target}`);
    continue;
  }
  // Stale (dead or foreign clone), duplicate, or wrongly-named link — prune;
  // the canonical link is (re)created below if missing.
  changed = true;
  log.push(`- extensions: removed ${canonical ? "duplicate" : "stale"} ${name} → ${target}`);
  actions.push(() => rmSync(entryPath));
}

if (!kept) {
  changed = true;
  log.push(`+ extensions += ${LINK_NAME} → ${CANONICAL_DIR}`);
  actions.push(() => {
    mkdirSync(EXTENSIONS_DIR, { recursive: true });
    symlinkSync(CANONICAL_DIR, CANONICAL_LINK);
  });
}

if (CHECK_ONLY) {
  // Exit 3 = changes pending (machine-checkable stale signal); 0 = already current.
  log.push(changed ? "✓ preflight passed — omp registration would be updated" : "✓ preflight passed — omp registration already current");
  console.log(log.join("\n"));
  process.exit(changed ? 3 : 0);
}

for (const action of actions) action();
if (changed) log.push(`✓ omp registration updated in ${EXTENSIONS_DIR}`);
console.log(log.join("\n"));

#!/usr/bin/env bun
// Idempotently reconciles the oh-my-pi (omp) extension registration (#18, #109)
// per the reconcile-and-prune contract (#77). Echo owns exactly ONE entry in
// ~/.omp/agent/extensions/: the `echo-voice` symlink pointing at THIS repo's
// dedicated `adapters/omp` directory (omp loads the entries declared in
// package.json's `pi` field through it). No other entry is ever touched —
// including links under other names whose target happens to end in adapters/omp
// or adapters/pi.
//
// MIGRATION (#109): omp previously loaded the SHARED `adapters/pi` adapter. This
// reconcile MIGRATES an existing Echo-owned `echo-voice` link off `adapters/pi`
// onto `adapters/omp`. The `echo-voice` entry is healed/migrated only when it
// provably belongs to Echo: a dead target spelled */adapters/{pi,omp} (a clone
// before a rename), or a live target whose package.json name is `@echo/omp-adapter`
// (a dedicated omp clone) or `@echo/pi-adapter` (the pre-split shared adapter —
// migrated). Anything else occupying the name — a real file/dir, an unrelated
// symlink, or a live non-Echo adapters/{pi,omp} target — is FATAL (exit 2), never
// replaced.
//
// Safe to run repeatedly. `--check` reports without mutating (exit 3 =
// changes pending, 0 = current, 2 = fatal).

import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_DIR = process.env.OMP_EXTENSIONS_DIR || join(homedir(), ".omp/agent/extensions");
const LINK_NAME = "echo-voice";
// Both markers are Echo-owned: the dedicated omp adapter and the pre-split shared
// Pi adapter (migrated onto adapters/omp).
const OWNERSHIP_MARKERS = new Set(["@echo/omp-adapter", "@echo/pi-adapter"]);
const CHECK_ONLY = process.argv.includes("--check");

const CANONICAL_DIR = realpathSync(ADAPTER_DIR);
const CANONICAL_LINK = join(EXTENSIONS_DIR, LINK_NAME);

// An Echo clone's adapter dir spelling — the dedicated omp adapter, or the
// pre-split shared pi adapter we migrate from.
function isEchoCloneSpelling(target: string): boolean {
  return /(^|\/)adapters\/(omp|pi)\/?$/.test(target);
}

/** Resolved real path of a link target, or null when the target is dead. */
function resolveTarget(target: string): string | null {
  const abs = isAbsolute(target) ? target : resolve(EXTENSIONS_DIR, target);
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}

/** Ownership marker: the target directory is an Echo omp/pi adapter checkout. */
function isEchoAdapterPackage(realDir: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(realDir, "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg?.name === "string" && OWNERSHIP_MARKERS.has(pkg.name);
  } catch {
    return false;
  }
}

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

let op: "none" | "create" | "replace" = "create";
const log: string[] = [];

// lstat (not existsSync): a dead symlink must still be seen and classified.
let linkStat: ReturnType<typeof lstatSync> | null = null;
try {
  linkStat = lstatSync(CANONICAL_LINK);
} catch {
  linkStat = null;
}

if (linkStat) {
  if (!linkStat.isSymbolicLink()) {
    fatal(`${CANONICAL_LINK} exists but is not a symlink — refusing to replace it`);
  }
  const target = readlinkSync(CANONICAL_LINK);
  const real = resolveTarget(target);
  if (real === CANONICAL_DIR) {
    op = "none";
    log.push(`= extensions already has ${LINK_NAME} → ${target}`);
  } else if (real === null && isEchoCloneSpelling(target)) {
    // Dead */adapters/{pi,omp} target: a clone's link from before a rename/move.
    op = "replace";
    log.push(`~ extensions: ${LINK_NAME} ${target} (dead) → ${CANONICAL_DIR}`);
  } else if (real !== null && isEchoCloneSpelling(target) && isEchoAdapterPackage(real)) {
    // Live link into an Echo clone (adapters/pi = pre-split shared adapter, or
    // another omp clone) — reconcile migrates/re-points it at this adapters/omp.
    op = "replace";
    const kind = /adapters\/pi\/?$/.test(target) ? "migrating from adapters/pi" : "other Echo clone";
    log.push(`~ extensions: ${LINK_NAME} ${target} (${kind}) → ${CANONICAL_DIR}`);
  } else {
    fatal(`${CANONICAL_LINK} is a symlink to ${target}, which is not an Echo adapter checkout — refusing to replace it`);
  }
} else {
  log.push(`+ extensions += ${LINK_NAME} → ${CANONICAL_DIR}`);
}

if (CHECK_ONLY) {
  // Exit 3 = changes pending (machine-checkable stale signal); 0 = already current.
  const pending = op !== "none";
  log.push(pending ? "✓ preflight passed — omp registration would be updated" : "✓ preflight passed — omp registration already current");
  console.log(log.join("\n"));
  process.exit(pending ? 3 : 0);
}

if (op !== "none") {
  if (op === "replace") rmSync(CANONICAL_LINK);
  mkdirSync(EXTENSIONS_DIR, { recursive: true });
  symlinkSync(CANONICAL_DIR, CANONICAL_LINK);
  log.push(`✓ omp registration updated in ${EXTENSIONS_DIR}`);
}
console.log(log.join("\n"));

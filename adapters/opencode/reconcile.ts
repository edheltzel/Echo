#!/usr/bin/env bun
/**
 * Idempotent reconcile-and-prune for the OpenCode host adapter (#77).
 *
 * OpenCode auto-loads `~/.config/opencode/plugins/`. Echo owns exactly one
 * entry there: the `echo-voice.ts` symlink pointing at this checkout's
 * `adapters/opencode/plugin.ts`. Sibling plugins are never rewritten or pruned.
 *
 * A dead Echo spelling (path ending in adapters/opencode/plugin.ts) is healed. Anything
 * else occupying the name — a real file, a directory, or a non-Echo symlink —
 * is FATAL (exit 2), never replaced.
 *
 * `--check` reports without mutating (exit 3 = pending, 0 = current, 2 = fatal).
 */
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenCodePluginsDir } from "./config-path.ts";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ENTRY = join(ADAPTER_DIR, "plugin.ts");
const LINK_NAME = "echo-voice.ts";
const ECHO_PLUGIN_RE = /(^|\/)adapters\/opencode\/plugin\.ts$/;
const OWNERSHIP_MARKER = "@echo/opencode-adapter";

const PLUGINS_DIR = resolveOpenCodePluginsDir();
const CANONICAL_PLUGIN = realpathSync(PLUGIN_ENTRY);
const CANONICAL_LINK = join(PLUGINS_DIR, LINK_NAME);

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function isEchoPluginSpelling(target: string): boolean {
  return ECHO_PLUGIN_RE.test(target);
}

function isEchoAdapterPackage(realPlugin: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(realPlugin), "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === OWNERSHIP_MARKER;
  } catch {
    return false;
  }
}

function resolveTarget(target: string): string | null {
  const abs = isAbsolute(target) ? target : resolve(PLUGINS_DIR, target);
  try {
    return realpathSync(abs);
  } catch {
    return null;
  }
}

let op: "none" | "create" | "replace" = "create";
const log: string[] = [];

let linkStat: Stats | null = null;
try {
  linkStat = lstatSync(CANONICAL_LINK);
} catch {
  linkStat = null;
}

if (linkStat) {
  if (!linkStat.isSymbolicLink()) {
    fatal(`${CANONICAL_LINK} exists but is not a symlink - refusing to replace it`);
  }
  const target = readlinkSync(CANONICAL_LINK);
  const real = resolveTarget(target);
  if (real === CANONICAL_PLUGIN) {
    op = "none";
    log.push(`= plugins already has ${LINK_NAME} → ${target}`);
  } else if (real === null && isEchoPluginSpelling(target)) {
    op = "replace";
    log.push(`~ plugins: ${LINK_NAME} ${target} (dead) → ${CANONICAL_PLUGIN}`);
  } else if (real !== null && isEchoPluginSpelling(real) && isEchoAdapterPackage(real)) {
    op = "replace";
    log.push(`~ plugins: ${LINK_NAME} ${target} → ${CANONICAL_PLUGIN}`);
  } else {
    fatal(
      `${CANONICAL_LINK} is a symlink to ${target}, which is not an Echo OpenCode plugin - refusing to replace it`,
    );
  }
} else {
  log.push(`+ plugins += ${LINK_NAME} → ${CANONICAL_PLUGIN}`);
}

if (CHECK_ONLY) {
  const pending = op !== "none";
  log.push(
    pending
      ? "✓ preflight passed - OpenCode registration would be updated"
      : "✓ preflight passed - OpenCode registration already current",
  );
  console.log(log.join("\n"));
  process.exit(pending ? 3 : 0);
}

if (op !== "none") {
  if (op === "replace") rmSync(CANONICAL_LINK);
  mkdirSync(PLUGINS_DIR, { recursive: true });
  symlinkSync(CANONICAL_PLUGIN, CANONICAL_LINK);
  log.push(`✓ OpenCode plugin registration updated in ${PLUGINS_DIR}`);
}
console.log(log.join("\n"));

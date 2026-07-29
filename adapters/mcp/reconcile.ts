#!/usr/bin/env bun
// Registers the echo-converse MCP server in Claude Code's config, following the
// reconcile-and-prune contract (#77, docs/adapters.md):
//
//   1. the canonical path comes from this file's own location, never a hardcoded clone
//   2. stale variants from a renamed or moved clone are pruned, not stacked
//   3. rerunning against a correct config is a byte-for-byte no-op
//   4. --check reports without mutating (exit 0 current, 3 pending, 2 fatal)
//   5. the resolved real file is replaced, so a config symlinked into a dotfiles
//      repo keeps its symlink
//
// Ownership is strict, exactly as the omp reconciler is: echo owns the
// `echo-converse` server name and nothing else. If that name is occupied by
// something that is not an echo MCP adapter, this aborts rather than
// overwriting a config entry it does not own.

import { readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(ADAPTER_DIR, "server.ts");

/** Claude Code keeps user-scope MCP servers in ~/.claude.json. Overridable for tests. */
const CONFIG_PATH = process.env.ECHO_MCP_CONFIG_PATH || join(homedir(), ".claude.json");

const SERVER_NAME = "echo-converse";
const CHECK_ONLY = process.argv.includes("--check");

/** Any registration whose command line points at an echo MCP adapter. */
const ECHO_MCP_ENTRY_RE = /\/adapters\/mcp\/server\.ts$/;

interface McpServerEntry {
  type?: string;
  command?: string;
  args?: string[];
  [key: string]: unknown;
}

interface ClaudeConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function canonicalEntryPath(): string {
  // realpath so a canonical entry spelled through a symlinked checkout is
  // recognized as current instead of pruned and re-added on every run.
  try {
    return realpathSync(SERVER_ENTRY);
  } catch {
    fatal(`the MCP server entry is missing at ${SERVER_ENTRY}`);
  }
}

function loadConfig(): ClaudeConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ClaudeConfig;
  } catch (thrown) {
    const code = (thrown as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    fatal(`could not read ${CONFIG_PATH}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
  }
}

function entryTargets(entry: McpServerEntry): string[] {
  return (entry.args ?? []).filter((arg): arg is string => typeof arg === "string");
}

/** True when this entry is one of ours (any clone), rather than a foreign server. */
function looksLikeEchoAdapter(entry: McpServerEntry): boolean {
  return entryTargets(entry).some((arg) => ECHO_MCP_ENTRY_RE.test(arg));
}

function resolveOrKeep(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path; // a dead path stays itself, so it compares unequal and gets pruned
  }
}

const canonical = canonicalEntryPath();
const config = loadConfig();
const servers: Record<string, McpServerEntry> = { ...(config.mcpServers ?? {}) };
const changes: string[] = [];

const desired: McpServerEntry = { type: "stdio", command: "bun", args: [canonical] };

// 1) Refuse to touch the name if something else already holds it.
const existing = servers[SERVER_NAME];
if (existing !== undefined && !looksLikeEchoAdapter(existing)) {
  fatal(
    `${CONFIG_PATH} already has an MCP server named "${SERVER_NAME}" that is not an echo adapter ` +
      `(command: ${existing.command ?? "?"} ${entryTargets(existing).join(" ")}). ` +
      "Echo will not overwrite a registration it does not own; rename or remove that entry first.",
  );
}

// 2) Prune echo MCP registrations under any other name: a rename leaves the old
// one behind, and two servers exposing the same tool is a duplicate tool in
// every session.
for (const [name, entry] of Object.entries(servers)) {
  if (name === SERVER_NAME) continue;
  if (!looksLikeEchoAdapter(entry)) continue;
  delete servers[name];
  changes.push(`remove stale echo MCP registration "${name}" (${entryTargets(entry).join(" ")})`);
}

// 3) Set the canonical entry, in place.
const currentTargets = existing === undefined ? [] : entryTargets(existing).map(resolveOrKeep);
const isCurrent =
  existing !== undefined &&
  existing.type === desired.type &&
  existing.command === desired.command &&
  currentTargets.length === 1 &&
  currentTargets[0] === canonical;

if (!isCurrent) {
  servers[SERVER_NAME] = desired;
  changes.push(
    existing === undefined
      ? `register "${SERVER_NAME}" -> bun ${canonical}`
      : `repoint "${SERVER_NAME}" -> bun ${canonical}`,
  );
}

if (CHECK_ONLY) {
  for (const change of changes) console.log(`pending: ${change}`);
  if (changes.length === 0) console.log(`current: "${SERVER_NAME}" -> bun ${canonical}`);
  process.exit(changes.length > 0 ? 3 : 0);
}

if (changes.length === 0) {
  console.log(`✓ MCP registration already current: "${SERVER_NAME}" -> bun ${canonical}`);
  process.exit(0);
}

config.mcpServers = servers;

// Replace the resolved real file so a config symlinked into a dotfiles repo is
// updated through the link rather than replaced by a regular file.
const realPath = resolveOrKeep(CONFIG_PATH);
const temp = `${realPath}.echo-mcp.tmp`;
writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`);
renameSync(temp, realPath);

for (const change of changes) console.log(`✓ ${change}`);
console.log(`  config: ${realPath}`);

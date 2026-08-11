#!/usr/bin/env bun

/**
 * Idempotent reconcile-and-prune for the Grok Build host adapter (#77).
 *
 * Echo owns exactly one file under the always-trusted global hooks directory:
 *   $GROK_HOME/hooks/echo-voice.json  (default ~/.grok/hooks/echo-voice.json)
 *
 * Sibling files (e.g. firstmate's fm-turn-end.json / fm-turn-end.sh) are never
 * rewritten or pruned. Target directory is resolved from the environment so
 * tests can use a scratch home without touching the operator's real ~/.grok.
 *
 * --check: exit 0 current, 3 pending, 2 fatal ownership conflict.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
const OWNED_FILENAME = "echo-voice.json";

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function resolveHooksDir(): string {
  if (process.env.ECHO_GROK_HOOKS_DIR?.trim()) {
    return process.env.ECHO_GROK_HOOKS_DIR.trim();
  }
  const grokHome = process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
  return join(grokHome, "hooks");
}

function canonicalHookPath(): string {
  try {
    return realpathSync(HOOK_ENTRY);
  } catch {
    fatal(`the Grok hook entry is missing at ${HOOK_ENTRY}`);
  }
}

function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function desiredDocument(hookPath: string): { text: string } {
  const command = `bun ${shellQuote(hookPath)}`;
  const doc = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: 10,
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command,
              timeout: 30,
            },
          ],
        },
      ],
    },
  };
  return { text: `${JSON.stringify(doc, null, 2)}\n` };
}

function looksLikeEchoGrokHook(text: string): boolean {
  return text.includes("adapters/grok/hook.ts");
}

const hooksDir = resolveHooksDir();
const ownedPath = join(hooksDir, OWNED_FILENAME);
const canonical = canonicalHookPath();
const desired = desiredDocument(canonical);
const log: string[] = [];
let changed = false;

// Ownership: if echo-voice.json exists and is not an Echo grok registration, refuse.
let existingText: string | null = null;
let destination = ownedPath;
try {
  const st = lstatSync(ownedPath);
  if (st.isSymbolicLink()) {
    try {
      destination = realpathSync(ownedPath);
    } catch {
      fatal(`${ownedPath} is a dead symlink - refusing to replace it`);
    }
  }
  existingText = readFileSync(destination, "utf8");
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  if (code !== "ENOENT") {
    fatal(`could not read ${ownedPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (existingText !== null) {
  if (!looksLikeEchoGrokHook(existingText)) {
    fatal(
      `${ownedPath} exists but is not an Echo Grok adapter registration. ` +
        "Echo will not overwrite a hook file it does not own; rename or remove it first.",
    );
  }
  if (existingText === desired.text) {
    log.push(`= ${OWNED_FILENAME} already current → ${canonical}`);
  } else {
    changed = true;
    log.push(`~ ${OWNED_FILENAME} → ${canonical}`);
  }
} else {
  changed = true;
  log.push(`+ ${OWNED_FILENAME} → ${canonical}`);
}

// Never prune sibling files. Only report that we leave them alone when present
// (helps operators and the foreign-file preservation test prove non-mutation).
if (existsSync(hooksDir)) {
  try {
    const siblings = readdirSync(hooksDir).filter((name) => name !== OWNED_FILENAME);
    if (siblings.length > 0) {
      log.push(`= leaving ${siblings.length} non-Echo hook file(s) untouched`);
    }
  } catch {
    // Directory listing is best-effort; missing perms should not fail reconcile.
  }
}

if (CHECK_ONLY) {
  console.log(
    [
      ...log,
      changed
        ? "✓ preflight passed - Grok hooks would be updated"
        : "✓ preflight passed - Grok hooks already current",
    ].join("\n"),
  );
  process.exit(changed ? 3 : 0);
}

if (changed) {
  mkdirSync(hooksDir, { recursive: true });
  const temporary = join(dirname(destination), `.${OWNED_FILENAME}.echo-${process.pid}`);
  writeFileSync(temporary, desired.text, { mode: 0o600 });
  renameSync(temporary, destination);
  try {
    chmodSync(destination, 0o600);
  } catch {
    // Best-effort mode bits.
  }
}

console.log(
  [...log, `✓ Grok hook registration ${changed ? "updated" : "already current"}`].join("\n"),
);

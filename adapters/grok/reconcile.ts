#!/usr/bin/env bun

/**
 * Idempotent reconcile-and-prune for the Grok Build host adapter (#77).
 *
 * Echo owns:
 *   $GROK_HOME/hooks/echo-voice.json  (lifecycle voice; not the mute path)
 *   $GROK_HOME/skills/echo-mute/      (/echo-mute → bash cli/echo mute)
 *
 * Sibling files are never rewritten or pruned.
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
import { applyOwnedSymlink, ownedLinkLog, planOwnedSymlink } from "@echo/shared/owned-symlink.ts";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const HOOK_ENTRY = join(ADAPTER_DIR, "hook.ts");
const OWNED_FILENAME = "echo-voice.json";

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function grokHome(): string {
  return process.env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

function resolveHooksDir(): string {
  return process.env.ECHO_GROK_HOOKS_DIR?.trim() || join(grokHome(), "hooks");
}

function skillsDir(): string {
  const override = process.env.ECHO_GROK_SKILLS_DIR?.trim();
  if (override) return override;
  const hooks = process.env.ECHO_GROK_HOOKS_DIR?.trim();
  return hooks ? join(dirname(hooks), "skills") : join(grokHome(), "skills");
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

const muteSource = join(ADAPTER_DIR, "skills", "echo-mute");
let muteSkillSource: string;
try {
  muteSkillSource = realpathSync(muteSource);
} catch {
  fatal(`the Grok mute skill is missing at ${muteSource}`);
}
const muteSkill = planOwnedSymlink({
  destination: join(skillsDir(), "echo-mute"),
  source: muteSkillSource,
  isEchoSpelling: (target) => /(^|\/)adapters\/grok\/skills\/echo-mute\/?$/.test(target),
  fatal,
});
if (muteSkill.kind !== "current") changed = true;
log.push(ownedLinkLog(muteSkill, "skills/echo-mute"));

if (CHECK_ONLY) {
  console.log(
    [
      ...log,
      changed
        ? "✓ preflight passed - Grok hooks/mute skill would be updated"
        : "✓ preflight passed - Grok hooks and mute skill already current",
    ].join("\n"),
  );
  process.exit(changed ? 3 : 0);
}

if (existingText === null || existingText !== desired.text) {
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

applyOwnedSymlink(muteSkill);

console.log(
  [...log, `✓ Grok hook/mute registration ${changed ? "updated" : "already current"}`].join("\n"),
);

#!/usr/bin/env bun
// Idempotently re-applies echo's Claude Code settings.json hook registrations.
// Safe to run repeatedly. Backs up settings.json before mutating.

import { chmodSync, copyFileSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = process.env.PAI_SETTINGS_PATH || join(homedir(), ".claude/settings.json");
const REPO_HOOKS_DIR = join(ADAPTER_DIR, "hooks");

const VOICE_GATE_CMD = join(REPO_HOOKS_DIR, "VoiceGate.hook.ts");
const VOICE_GREETING_CMD = join(REPO_HOOKS_DIR, "VoiceGreeting.hook.ts");
const VOICE_COMPLETION_CMD = join(REPO_HOOKS_DIR, "VoiceCompletion.hook.ts");

// A standalone install can wire the Stop hook directly at ~/.claude/hooks/VoiceCompletion.hook.ts.
// Treat it as the same registration so we replace it in place with the adapter copy rather than
// stacking a duplicate Stop hook.
const UNMANAGED_VOICE_COMPLETION_CMD = join(homedir(), ".claude/hooks/VoiceCompletion.hook.ts");
const VOICE_COMPLETION_CMDS = new Set([VOICE_COMPLETION_CMD, UNMANAGED_VOICE_COMPLETION_CMD]);

const CHECK_ONLY = process.argv.includes("--check");

type HookEntry = { type?: string; command: string };
type MatcherEntry = { matcher?: string; hooks: HookEntry[] };
type Settings = { hooks?: Record<string, MatcherEntry[]>; [k: string]: unknown };

function loadSettings(): Settings {
  const raw = readFileSync(SETTINGS_PATH, "utf8");
  return JSON.parse(raw) as Settings;
}

const settings = loadSettings();
settings.hooks ??= {};
settings.hooks.PreToolUse ??= [];
settings.hooks.SessionStart ??= [];
settings.hooks.Stop ??= [];

let changed = false;
const log: string[] = [];

// 0) Prune stale foreign-clone registrations (#77): any adapter hook file registered from a
// non-canonical adapters/claudecode/hooks directory — e.g. a pre-rename repo path. Matching
// the whole hooks dir (not a hook-name list) means future hook files can't escape pruning.
// Canonical is decided by realpath (dead-path-tolerant, like the Pi reconciler), so a live
// canonical hook spelled through a symlinked repo path is normalized in place rather than
// pruned and re-added. The unmanaged ~/.claude/hooks/VoiceCompletion.hook.ts doesn't match
// this pattern; step 3 replaces it in place instead.
const ADAPTER_HOOK_RE = /\/adapters\/claudecode\/hooks\/[^/]+\.hook\.ts$/;
const REAL_HOOKS_DIR = realpathSync(REPO_HOOKS_DIR);
for (const [event, entries] of Object.entries(settings.hooks)) {
  if (!Array.isArray(entries)) continue;
  for (const entry of entries) {
    if (!Array.isArray(entry.hooks)) continue;
    for (const hook of [...entry.hooks]) {
      if (!ADAPTER_HOOK_RE.test(hook.command)) continue;
      let real: string | null = null;
      try {
        real = realpathSync(hook.command);
      } catch {
        real = null; // dead path
      }
      if (real === null || dirname(real) !== REAL_HOOKS_DIR) {
        entry.hooks.splice(entry.hooks.indexOf(hook), 1);
        changed = true;
        log.push(`- ${event}: removed stale ${hook.command}`);
        continue;
      }
      const canonical = join(REPO_HOOKS_DIR, basename(real));
      if (hook.command !== canonical) {
        hook.command = canonical;
        changed = true;
        log.push(`~ ${event}: normalized ${basename(real)} → repo spelling`);
      }
    }
  }
}

// Reconcile a single matcher entry to exactly one canonical hook registration:
// add it if absent, and collapse any duplicates so a stale + adapter pair can't survive.
function reconcileEntry(entry: MatcherEntry, canonical: string, loc: string, hookFile: string): void {
  const matches = entry.hooks.filter((h) => h.command === canonical);
  if (matches.length === 0) {
    entry.hooks.push({ type: "command", command: canonical });
    changed = true;
    log.push(`+ ${loc} += ${hookFile}`);
    return;
  }
  if (matches.length === 1) {
    log.push(`= ${loc} already has ${hookFile}`);
  }
  for (const dup of matches.slice(1)) {
    entry.hooks.splice(entry.hooks.indexOf(dup), 1);
    changed = true;
    log.push(`- ${loc}: removed duplicate ${hookFile}`);
  }
}

// 1) Add VoiceGate to existing PreToolUse matcher="Bash" entry.
const bashEntry = settings.hooks.PreToolUse.find((entry) => entry.matcher === "Bash");
if (!bashEntry) {
  console.error("FATAL: no PreToolUse matcher='Bash' entry found in settings.json");
  process.exit(2);
}
reconcileEntry(bashEntry, VOICE_GATE_CMD, "PreToolUse[matcher=Bash]", "VoiceGate.hook.ts");

// 2) Add SessionStart matcher="startup" entry with VoiceGreeting.
let startupEntry = settings.hooks.SessionStart.find((entry) => entry.matcher === "startup");
if (!startupEntry) {
  startupEntry = { matcher: "startup", hooks: [] };
  settings.hooks.SessionStart.push(startupEntry);
  changed = true;
  log.push('+ SessionStart += { matcher: "startup", hooks: [] }');
}
reconcileEntry(startupEntry, VOICE_GREETING_CMD, "SessionStart[matcher=startup]", "VoiceGreeting.hook.ts");

// 3) Point the Stop hook at the adapter's VoiceCompletion, replacing an unmanaged
//    ~/.claude/hooks/VoiceCompletion.hook.ts a standalone install wired, and collapsing
//    duplicates across all Stop entries so only one registration survives.
const completionMatches: { entry: MatcherEntry; hook: HookEntry }[] = [];
for (const entry of settings.hooks.Stop) {
  for (const hook of entry.hooks) {
    if (VOICE_COMPLETION_CMDS.has(hook.command)) completionMatches.push({ entry, hook });
  }
}

if (completionMatches.length === 0) {
  // No existing registration — add to a default (matcher-less) Stop entry, creating one if needed.
  let defaultStop = settings.hooks.Stop.find((entry) => entry.matcher === undefined || entry.matcher === "");
  if (!defaultStop) {
    defaultStop = { hooks: [] };
    settings.hooks.Stop.push(defaultStop);
    log.push("+ Stop += { hooks: [] }");
  }
  defaultStop.hooks.push({ type: "command", command: VOICE_COMPLETION_CMD });
  changed = true;
  log.push("+ Stop += VoiceCompletion.hook.ts");
} else {
  const [{ hook: keep }, ...extra] = completionMatches;
  if (keep.command !== VOICE_COMPLETION_CMD) {
    keep.command = VOICE_COMPLETION_CMD;
    changed = true;
    log.push("~ Stop: VoiceCompletion.hook.ts → repo copy");
  } else if (extra.length === 0) {
    log.push("= Stop already points VoiceCompletion.hook.ts at repo copy");
  }
  for (const { entry, hook } of extra) {
    entry.hooks.splice(entry.hooks.indexOf(hook), 1);
    changed = true;
    log.push("- Stop: removed duplicate VoiceCompletion.hook.ts");
  }
}

if (CHECK_ONLY) {
  // Exit 3 = changes pending (machine-checkable stale signal); 0 = already current.
  log.push(changed ? "✓ preflight passed — settings.json would be updated" : "✓ preflight passed — settings.json already current");
  console.log(log.join("\n"));
  process.exit(changed ? 3 : 0);
}

if (changed) {
  // Write through a possible symlink: atomically replace the resolved real file, so a
  // settings.json symlinked into a dotfiles repo stays a symlink (#77).
  const realPath = realpathSync(SETTINGS_PATH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${realPath}.bak-${stamp}`;
  const temp = `${realPath}.tmp-${process.pid}`;
  copyFileSync(realPath, backup);
  writeFileSync(temp, JSON.stringify(settings, null, 2) + "\n");
  renameSync(temp, realPath);
  log.push(`✓ settings.json updated (backup: ${backup})`);
} else {
  log.push("✓ settings.json already current — no write");
}

// 4) Enforce mode 0600.
const mode = statSync(SETTINGS_PATH).mode & 0o777;
if (mode !== 0o600) {
  chmodSync(SETTINGS_PATH, 0o600);
  log.push(`✓ chmod 0${mode.toString(8)} → 0600`);
} else {
  log.push("= mode already 0600");
}

console.log(log.join("\n"));

#!/usr/bin/env bun

import {
  lstatSync,
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
const CONFIG_PATH = process.env.JCODE_CONFIG_PATH
  ?? join(process.env.JCODE_HOME ?? join(homedir(), ".jcode"), "config.toml");
const HOOK_PATH = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "hook.ts"));
const HOOK_KEYS = ["turn_end", "session_start"] as const;
const ECHO_HOOK_RE = /(^|\/)adapters\/jcode\/hook\.ts$/;

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function configStat(): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(CONFIG_PATH);
  } catch {
    return null;
  }
}

function unquoteToml(value: string): string | null {
  try {
    const parsed = Bun.TOML.parse(`value = ${value}`) as { value?: unknown };
    return typeof parsed.value === "string" ? parsed.value : null;
  } catch {
    return null;
  }
}

function reconcileText(input: string): { output: string; changed: boolean; log: string[] } {
  if (input.trim()) {
    try {
      Bun.TOML.parse(input);
    } catch (error) {
      fatal(`${CONFIG_PATH} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const lines = input ? input.replace(/\n$/, "").split("\n") : [];
  let hooksStart = lines.findIndex((line) => /^\s*\[hooks\]\s*(?:#.*)?$/.test(line));
  let hooksEnd = hooksStart < 0
    ? -1
    : lines.findIndex((line, index) => index > hooksStart && /^\s*\[[^]]+\]\s*(?:#.*)?$/.test(line));
  if (hooksStart >= 0 && hooksEnd < 0) hooksEnd = lines.length;

  const log: string[] = [];
  let changed = false;
  const canonicalValue = JSON.stringify(HOOK_PATH);

  if (hooksStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push("");
    hooksStart = lines.length;
    lines.push("[hooks]");
    hooksEnd = lines.length;
    changed = true;
    log.push("+ added [hooks]");
  }

  for (const key of HOOK_KEYS) {
    const matcher = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`);
    let found = -1;
    for (let index = hooksStart + 1; index < hooksEnd; index++) {
      const match = lines[index].match(matcher);
      if (!match) continue;
      const current = unquoteToml(match[1]);
      if (current === null) fatal(`[hooks].${key} is not a string`);
      if (current === HOOK_PATH) {
        found = index;
        log.push(`= [hooks].${key} already current`);
        break;
      }
      if (current && !ECHO_HOOK_RE.test(current)) {
        fatal(`[hooks].${key} already belongs to another command (${current}); Jcode supports one command per hook`);
      }
      lines[index] = `${key} = ${canonicalValue}`;
      found = index;
      changed = true;
      log.push(`~ [hooks].${key} → ${HOOK_PATH}`);
      break;
    }
    if (found < 0) {
      lines.splice(hooksEnd, 0, `${key} = ${canonicalValue}`);
      hooksEnd++;
      changed = true;
      log.push(`+ [hooks].${key} = ${HOOK_PATH}`);
    }
  }

  return { output: lines.join("\n") + "\n", changed, log };
}

const initialStat = configStat();
let destination = CONFIG_PATH;
if (initialStat?.isSymbolicLink()) {
  try {
    destination = realpathSync(CONFIG_PATH);
  } catch {
    fatal(`${CONFIG_PATH} is a dead symlink — refusing to replace it`);
  }
}
const input = initialStat ? readFileSync(destination, "utf8") : "";
const result = reconcileText(input);

if (CHECK_ONLY) {
  console.log([...result.log, result.changed ? "✓ preflight passed — Jcode hooks would be updated" : "✓ preflight passed — Jcode hooks already current"].join("\n"));
  process.exit(result.changed ? 3 : 0);
}

if (result.changed) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  const temporary = join(dirname(destination), `.config.toml.echo-${process.pid}`);
  writeFileSync(temporary, result.output, { mode: 0o600 });
  renameSync(temporary, destination);
}
console.log([...result.log, `✓ Jcode hook registration ${result.changed ? "updated" : "already current"}`].join("\n"));

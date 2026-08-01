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
const HOOK_COMMAND = `'${HOOK_PATH.replaceAll("'", `'\\''`)}'`;
const HOOK_KEYS = ["turn_end", "session_start"] as const;
const HOOKS_HEADER_RE = /^\s*\[(?:hooks|"hooks"|'hooks')\]\s*(?:#.*)?$/;
const ANY_HEADER_RE = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/;

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

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let triple = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (quote === '"' && char === "\\") {
        index++;
        continue;
      }
      if (triple && line.slice(index, index + 3) === quote.repeat(3)) {
        index += 2;
        quote = null;
        triple = false;
        continue;
      }
      if (!triple && char === quote) quote = null;
      continue;
    }
    if (char === "#") return line.slice(0, index);
    if (char === '"' || char === "'") {
      quote = char;
      triple = line.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
    }
  }
  return line;
}

function singleProgram(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll(`'\\''`, "'");
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  return /\s/.test(trimmed) ? null : trimmed;
}

function hasOnlyEchoHookPath(command: string): boolean {
  try {
    if (realpathSync(command) === HOOK_PATH) return true;
  } catch {
    // Fall through to shell-command parsing for the canonical quoted form.
  }
  const program = singleProgram(command);
  if (program === null) return false;
  try {
    return realpathSync(program) === HOOK_PATH;
  } catch {
    return false;
  }
}

function parseHookValue(raw: string, key: string): string {
  const current = unquoteToml(raw.trim());
  if (current === null) fatal(`[hooks].${key} is not a string`);
  return current;
}

function validateGeneratedOutput(output: string): void {
  let parsed: any;
  try {
    parsed = Bun.TOML.parse(output);
  } catch (error) {
    fatal(`generated config.toml is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) {
    fatal("generated config.toml did not preserve [hooks] as a table");
  }
  for (const key of HOOK_KEYS) {
    if (parsed.hooks[key] !== HOOK_COMMAND) fatal(`generated config.toml did not set [hooks].${key}`);
  }
}

function reconcileText(input: string): { output: string; changed: boolean; log: string[] } {
  let parsed: any = {};
  if (input.trim()) {
    try {
      parsed = Bun.TOML.parse(input);
    } catch (error) {
      fatal(`${CONFIG_PATH} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (Array.isArray(parsed.hooks)) fatal("[hooks] must be a table, not an array");
  if (parsed.hooks && typeof parsed.hooks !== "object") fatal("[hooks] must be a table");

  const lines = input ? input.replace(/\n$/, "").split("\n") : [];
  if (lines.some((line) => /^\s*\[\[\s*(?:hooks|"hooks"|'hooks')\s*\]\]/.test(stripTomlComment(line)))) {
    fatal("[[hooks]] array tables cannot be reconciled safely");
  }
  if (lines.some((line) => /^\s*hooks\s*=\s*\{/.test(stripTomlComment(line)))) {
    fatal("inline hooks tables cannot be reconciled safely; convert hooks to a [hooks] table");
  }

  const dottedHookLine = (key: string) => new RegExp(`^\\s*hooks\\.${key}\\s*=\\s*(.+?)\\s*$`);
  const hasDottedHooks = HOOK_KEYS.some((key) => lines.some((line) => dottedHookLine(key).test(stripTomlComment(line))));

  let hooksStart = lines.findIndex((line) => HOOKS_HEADER_RE.test(line));
  let hooksEnd = hooksStart < 0
    ? -1
    : lines.findIndex((line, index) => index > hooksStart && ANY_HEADER_RE.test(line));
  if (hooksStart >= 0 && hooksEnd < 0) hooksEnd = lines.length;

  const log: string[] = [];
  let changed = false;
  const canonicalValue = JSON.stringify(HOOK_COMMAND);

  if (hooksStart < 0 && !hasDottedHooks) {
    if (lines.length && lines.at(-1)?.trim()) lines.push("");
    hooksStart = lines.length;
    lines.push("[hooks]");
    hooksEnd = lines.length;
    changed = true;
    log.push("+ added [hooks]");
  }

  for (const key of HOOK_KEYS) {
    if (hooksStart < 0 && hasDottedHooks) {
      const matcher = dottedHookLine(key);
      let found = -1;
      for (let index = 0; index < lines.length; index++) {
        const match = stripTomlComment(lines[index]).match(matcher);
        if (!match) continue;
        const current = parseHookValue(match[1], key);
        if (current === HOOK_COMMAND) {
          found = index;
          log.push(`= hooks.${key} already current`);
          break;
        }
        if (current && !hasOnlyEchoHookPath(current)) {
          fatal(`[hooks].${key} already belongs to another command (${current}); Jcode supports one command per hook`);
        }
        lines[index] = `hooks.${key} = ${canonicalValue}`;
        found = index;
        changed = true;
        log.push(`~ hooks.${key} → ${HOOK_PATH}`);
        break;
      }
      if (found < 0) {
        lines.push(`hooks.${key} = ${canonicalValue}`);
        changed = true;
        log.push(`+ hooks.${key} = ${HOOK_PATH}`);
      }
      continue;
    }

    const matcher = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`);
    let found = -1;
    for (let index = hooksStart + 1; index < hooksEnd; index++) {
      const match = stripTomlComment(lines[index]).match(matcher);
      if (!match) continue;
      const current = parseHookValue(match[1], key);
      if (current === HOOK_COMMAND) {
        found = index;
        log.push(`= [hooks].${key} already current`);
        break;
      }
      if (current && !hasOnlyEchoHookPath(current)) {
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

  const output = lines.join("\n") + "\n";
  validateGeneratedOutput(output);
  return { output, changed, log };
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

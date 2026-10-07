import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK_ONLY = process.argv.includes("--check");
const ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(ADAPTER_DIR, "commands");
const COMMANDS_DIR = process.env.ECHO_CLAUDE_COMMANDS_DIR?.trim() || join(homedir(), ".claude/commands");
const ADAPTER_PACKAGE = "@echo/claudecode-adapter";

type Operation = {
  destination: string;
  filename: string;
  source: string;
  target?: string;
  kind: "current" | "create" | "replace";
};

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(2);
}

function resolveLink(destination: string, target: string): string | null {
  try {
    return realpathSync(resolve(dirname(destination), target));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    fatal(`could not resolve ${destination}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasEchoCommandSpelling(destination: string, target: string, filename: string): boolean {
  const absolute = resolve(dirname(destination), target);
  return absolute.endsWith(join("adapters", "claudecode", "commands", filename));
}

function isEchoOwnedLink(destination: string, target: string, filename: string, real: string | null): boolean {
  if (!hasEchoCommandSpelling(destination, target, filename)) return false;
  if (real === null) return true;
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(dirname(real)), "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === ADAPTER_PACKAGE;
  } catch {
    return false;
  }
}

const sourceNames = readdirSync(SOURCE_DIR).filter((name) => name.endsWith(".md")).sort();
if (sourceNames.length === 0) fatal(`no Claude Code commands found in ${SOURCE_DIR}`);

const operations: Operation[] = sourceNames.map((filename) => {
  const source = realpathSync(join(SOURCE_DIR, filename));
  const destination = join(COMMANDS_DIR, filename);
  let stat: ReturnType<typeof lstatSync> | null = null;
  try {
    stat = lstatSync(destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      fatal(`could not inspect ${destination}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (stat === null) return { destination, filename, source, kind: "create" };
  if (!stat.isSymbolicLink()) {
    fatal(`${destination} exists but is not an Echo-owned symlink. Echo will not overwrite it.`);
  }

  const target = readlinkSync(destination);
  const real = resolveLink(destination, target);
  if (real === source) return { destination, filename, source, target, kind: "current" };
  if (!isEchoOwnedLink(destination, target, filename, real)) {
    fatal(`${destination} points to ${target}, which is not an Echo command. Echo will not overwrite it.`);
  }
  return { destination, filename, source, target, kind: "replace" };
});

const changed = operations.some((operation) => operation.kind !== "current");
const log = operations.map((operation) => {
  if (operation.kind === "current") return `= ${operation.filename} already current -> ${operation.source}`;
  if (operation.kind === "replace") return `~ ${operation.filename} ${operation.target} -> ${operation.source}`;
  return `+ ${operation.filename} -> ${operation.source}`;
});

if (CHECK_ONLY) {
  log.push(changed ? "preflight passed - Claude Code commands would be updated" : "preflight passed - Claude Code commands already current");
  console.log(log.join("\n"));
  process.exit(changed ? 3 : 0);
}

if (changed) {
  mkdirSync(COMMANDS_DIR, { recursive: true });
  for (const operation of operations) {
    if (operation.kind === "current") continue;
    if (operation.kind === "replace") rmSync(operation.destination);
    symlinkSync(operation.source, operation.destination);
  }
}

log.push(`Claude Code commands ${changed ? "updated" : "already current"}`);
console.log(log.join("\n"));

import { describe, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Source-level regression checks for the property the whole capability rests on:
// the always-on side never opens the microphone. These checks are not runtime
// enforcement of indirect dependency behavior or process ancestry.
//
// The TCC spike measured what happens when it does. A capture under a launchd
// job produced TCC records with no responsible process ("Failed to fetch
// responsible file descriptor"), no prompt surface and no grant; the same
// capture spawned from the host terminal's tree attributed to the terminal app
// and delivered live audio. So the coordinator books and sequences, the caller
// captures, and prose alone will not keep it that way.
//
// Written in the same shape as tests/core/architecture-invariants.test.ts: when
// one of these fails, the error message is the fix instructions.

const CONVERSE_DIR = "converse";

/** The coordinator's entry points. Nothing reachable from these may capture. */
const COORDINATOR_ENTRIES = [join(CONVERSE_DIR, "server.ts"), join(CONVERSE_DIR, "main.ts")];

/** Modules that own capture, loadable only in the caller's process. */
const CAPTURE_MODULES = ["capture.ts", "capture-state.ts", "client.ts"].map((name) =>
  resolve(join(CONVERSE_DIR, name)),
);

function assertNoOffenders(offenders: string[], remediation: string): void {
  if (offenders.length > 0) {
    throw new Error(`${remediation}\n\nViolations found:\n` + offenders.map((o) => `  - ${o}`).join("\n"));
  }
}

function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (block) => "\n".repeat(block.length - block.replaceAll("\n", "").length))
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function relativeImports(file: string): string[] {
  const content = stripComments(readFileSync(file, "utf8"));
  return [...content.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)].map((match) => match[1]);
}

/** Every converse module reachable from `entries` by relative import. */
function transitiveImports(entries: string[]): string[] {
  const seen = new Set<string>();
  const queue = entries.map((entry) => resolve(entry));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of relativeImports(file)) queue.push(resolve(dirname(file), spec));
  }
  return [...seen];
}

function converseFiles(): string[] {
  return readdirSync(CONVERSE_DIR)
    .map((entry: string) => join(CONVERSE_DIR, entry))
    .filter((path: string) => statSync(path).isFile() && path.endsWith(".ts"));
}

describe("echo-converse architecture invariants", () => {
  // Invariant 1: the coordinator cannot even load the capture machinery.
  test("no coordinator-side module imports a capture module", () => {
    const reachable = new Set(transitiveImports(COORDINATOR_ENTRIES));

    assertNoOffenders(
      CAPTURE_MODULES.filter((module) => reachable.has(module)).map((module) => `${module} is reachable from the coordinator`),
      "The echo-converse coordinator must never load a capture module. An always-on process that " +
        "opens the microphone gets no TCC responsible process, no prompt surface and no usable " +
        "grant (measured on macOS 26.5.2). Capture belongs in converse/client.ts, which runs in " +
        "the calling host's own process tree.",
    );
  });

  // Invariant 2: the coordinator starts no subprocess at all, so it cannot
  // grow an inline capture that sidesteps invariant 1.
  test("no coordinator-side module spawns a subprocess", () => {
    const offenders: string[] = [];
    for (const file of transitiveImports(COORDINATOR_ENTRIES)) {
      stripComments(readFileSync(file, "utf8")).split("\n").forEach((line, index) => {
        if (/\b(Bun\.spawn(Sync)?|child_process|execSync|execFile)\b/.test(line)) {
          offenders.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assertNoOffenders(
      offenders,
      "The coordinator is a coordination surface: it books the microphone, speaks through core's " +
        "HTTP contract and waits. It spawns nothing, so no future edit can put a recorder behind " +
        "an always-on process. Subprocesses belong in converse/capture.ts.",
    );
  });

  // Invariant 3: process state is user-owned, matching the core/ rule.
  test("converse writes no process state to /tmp", () => {
    const offenders: string[] = [];
    for (const file of converseFiles()) {
      stripComments(readFileSync(file, "utf8")).split("\n").forEach((line, index) => {
        if (line.includes("/tmp")) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
      });
    }

    assertNoOffenders(
      offenders,
      "converse/ must not write process state to world-writable /tmp. Capture audio, booking " +
        "locks and capture state all live under user-owned paths (~/.local/state/echo/converse, " +
        "~/Library/Caches/echo/converse). os.tmpdir() inside tests/ is fine.",
    );
  });

  // Invariant 4: converse reaches core over HTTP and the state-file contract only.
  test("converse never imports core/", () => {
    const offenders: string[] = [];
    for (const file of converseFiles()) {
      const content = stripComments(readFileSync(file, "utf8"));
      for (const match of content.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
        if (/(^|\/)core\//.test(match[1])) offenders.push(`${file}: imports "${match[1]}"`);
      }
    }

    assertNoOffenders(
      offenders,
      "converse/ talks to the daemon over HTTP and through the capture-state file it reports in " +
        "GET /health. It must not import core/: the daemon may run from another clone, from a " +
        "staged payload, or with a different VOICES_PATH, so its own answer is the only correct one.",
    );
  });

  // Invariant 5: core keeps :3246, converse takes the ECHOV keypad port, and
  // the superseded :8890 proposal from the scoping documents stays retired.
  test("converse defaults to :32468 and leaves core on :3246", () => {
    const config = readFileSync(join(CONVERSE_DIR, "config.ts"), "utf8");
    const offenders: string[] = [];

    if (!config.includes("32468")) offenders.push("converse/config.ts: no 32468 default port");
    if (config.includes("8890")) offenders.push("converse/config.ts: references the superseded :8890 proposal");
    for (const file of converseFiles()) {
      if (readFileSync(file, "utf8").includes("31337")) offenders.push(`${file}: references :31337`);
    }

    assertNoOffenders(
      offenders,
      "echo-converse listens on :32468 (keypad ECHOV) and core stays on :3246. The :8890 in the " +
        "older scoping documents is superseded, and :31337 is the retired Pulse port.",
    );
  });

  test("does not claim source scans enforce microphone topology at runtime", () => {
    const server = readFileSync(join(CONVERSE_DIR, "server.ts"), "utf8");
    const packageContract = readFileSync(join(CONVERSE_DIR, "AGENTS.md"), "utf8");
    const docs = readFileSync(join("docs", "converse.md"), "utf8");
    const offenders: string[] = [];

    if (/mechanically\s+enforc/i.test(server)) offenders.push("converse/server.ts overclaims runtime enforcement");
    if (/enforced by\s+`?tests\/converse\/architecture-invariants/i.test(packageContract)) {
      offenders.push("converse/AGENTS.md overclaims runtime enforcement");
    }
    if (/Both properties are enforced by/i.test(docs)) offenders.push("docs/converse.md overclaims runtime enforcement");
    if (!/source-level|source scan|not runtime/i.test(docs)) offenders.push("docs/converse.md does not state the enforcement boundary");
    if (!/Claude Code[\s\S]{0,220}(not|unverified|unconfirmed)/i.test(docs)) {
      offenders.push("docs/converse.md does not state that Claude Code ancestry is unverified");
    }

    assertNoOffenders(
      offenders,
      "The coordinator/caller topology is a measured design boundary plus source-level regression " +
        "checks. Do not describe those checks as runtime enforcement, and keep the Claude Code bridge " +
        "path explicitly unverified until it is measured on the supported host.",
    );
  });
});

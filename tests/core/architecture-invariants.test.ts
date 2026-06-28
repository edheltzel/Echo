import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Mechanical enforcement of the statically-checkable `core/` invariants that
// AGENTS.md states as prose ("Invariants / must not do"). Prose gets ignored;
// a red test does not. Each assertion below carries a remediation message —
// when the test fails, the error output IS the fix instructions.
//
// Companion to `no-host-strings.test.ts` (broad string scan) — this file is
// import-precise (catches `adapters/**` + host SDK packages a string scan
// misses) and adds the :31337, /tmp, and route-name invariants.

const CORE_DIR = "core";

/** Every file under core/ (recursive), so a future subdir is covered too. */
function coreFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(CORE_DIR);
  return out;
}

/** Runtime TypeScript sources under core/ (excludes JSON config). */
function coreTsFiles(): string[] {
  return coreFiles().filter((f) => f.endsWith(".ts"));
}

/** Import/require/dynamic-import module specifiers in a source file. */
function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s+["']([^"']+)["']/g, // import ... from "x"
    /\brequire\(\s*["']([^"']+)["']\s*\)/g, // require("x")
    /\bimport\(\s*["']([^"']+)["']\s*\)/g, // import("x") dynamic
  ];
  for (const re of patterns) {
    for (const m of content.matchAll(re)) specs.push(m[1]);
  }
  return specs;
}

/**
 * Strip block and line comments so a documentation comment that merely mentions
 * a banned token (e.g. the "never /tmp" note in server.ts) is not a false
 * positive. Line-comment stripping skips `://` so URL strings survive.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but not `://`
}

/** Route path literals declared via `url.pathname === "..."`. */
function routePaths(content: string): string[] {
  return [...content.matchAll(/url\.pathname\s*===\s*["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
}

/** Fail with a remediation message when any offender is found. */
function assertNoOffenders(offenders: string[], remediation: string): void {
  if (offenders.length > 0) {
    throw new Error(
      `${remediation}\n\nViolations found:\n` +
        offenders.map((o) => `  - ${o}`).join("\n"),
    );
  }
}

describe("core architecture invariants", () => {
  // Invariant 1 — core/ imports no host APIs or adapters.
  test("core/ imports no host (PAI/Pi/Claude Code/OpenCode) or adapter modules", () => {
    // Specifiers that reach a host runtime or an out-of-core adapter.
    const banned: { re: RegExp; what: string }[] = [
      { re: /(^|\/)adapters\//, what: "adapters/** (host integration)" },
      { re: /@earendil-works\//, what: "Pi coding agent SDK" },
      { re: /@anthropic-ai\//, what: "Anthropic/Claude SDK" },
      { re: /\bclaude-code\b/i, what: "Claude Code" },
      { re: /\bopencode\b/i, what: "OpenCode" },
      { re: /(^|\/)pai(\/|$)/i, what: "PAI package" },
    ];
    const offenders: string[] = [];
    for (const file of coreTsFiles()) {
      for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
        const hit = banned.find((b) => b.re.test(spec));
        if (hit) offenders.push(`${file}: imports "${spec}" → ${hit.what}`);
      }
    }
    assertNoOffenders(
      offenders,
      "core/ must stay host-neutral: no imports of host APIs (PAI/Pi/Claude Code/OpenCode) " +
        "or of adapters/**. Host lifecycle logic belongs in an adapter that calls POST /notify. " +
        "Move shared types/helpers into core/ instead of importing outward.",
    );
  });

  // Invariant 2 — no :31337 references (voice traffic is :8888).
  test("core/ has no :31337 references (voice traffic is :8888)", () => {
    const offenders: string[] = [];
    for (const file of coreFiles()) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (line.includes("31337")) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assertNoOffenders(
      offenders,
      "core/ must not reference port :31337 (that was the old Pulse port). " +
        "Voice server traffic is :8888 — use that port.",
    );
  });

  // Invariant 3 — no /tmp process-state paths in core/ runtime source.
  test("core/ runtime source uses user-owned dirs, not world-writable /tmp", () => {
    const offenders: string[] = [];
    for (const file of coreTsFiles()) {
      const stripped = stripComments(readFileSync(file, "utf8"));
      stripped.split("\n").forEach((line, i) => {
        if (line.includes("/tmp")) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assertNoOffenders(
      offenders,
      "core/ must not write process state to /tmp (world-writable). " +
        "Use user-owned cache/log/config dirs (e.g. AUDIO_CACHE_DIR + mkdtempSync, " +
        "or ~/Library/Logs // $XDG_STATE_HOME). os.tmpdir() in tests/ is fine — this rule is core/ runtime only.",
    );
  });

  // Invariant 4 — no PAI-named (host-named) HTTP routes in core/server.ts.
  test("core/server.ts exposes no host-named HTTP routes", () => {
    const content = readFileSync(join(CORE_DIR, "server.ts"), "utf8");
    const offenders: string[] = [];
    for (const route of routePaths(content)) {
      const segments = route.split("/").filter(Boolean);
      const hostNamed =
        /(pai|claude|opencode)/i.test(route) ||
        segments.some((seg) => /^pi(-|$)/i.test(seg));
      if (hostNamed) offenders.push(`route "${route}"`);
    }
    assertNoOffenders(
      offenders,
      "The universal core exposes only host-neutral routes (/notify, /notify/personality, /health). " +
        "Do not add host-named (PAI/Pi/Claude/OpenCode) endpoints — host specifics belong in an adapter.",
    );
  });

  // Invariant 5 — the legacy PAI stow tree is retired and must not silently return.
  test("legacy PAI stow tree under claudecode/ stays retired", () => {
    expect(existsSync("claudecode/.claude/PAI/USER/Voice")).toBe(false);

    const tracked = Bun.spawnSync(["git", "ls-files", "claudecode/"]).stdout.toString().trim();
    if (tracked.length > 0) {
      throw new Error(
        "The legacy PAI stow tree was retired — no files may be tracked under claudecode/. " +
          "Host lifecycle glue lives in adapters/claudecode/.\n\nTracked files found:\n" +
          tracked,
      );
    }
  });

  // Invariant 6 — the old adapter name (adapters/pai) is retired and must not creep back.
  test("the old adapters/pai name stays retired (renamed to adapters/claudecode in #59)", () => {
    const tracked = Bun.spawnSync(["git", "ls-files", "adapters/pai", "tests/adapters/pai"])
      .stdout.toString()
      .trim();
    if (tracked.length > 0) {
      throw new Error(
        "The Claude Code adapter was renamed adapters/pai → adapters/claudecode (#59). " +
          "No files may be tracked under adapters/pai/ or tests/adapters/pai/.\n\nTracked files found:\n" +
          tracked,
      );
    }

    const installScript = readFileSync(join("scripts", "install.sh"), "utf8");
    const offenders: string[] = [];
    if (/--adapter\s+pai\b/.test(installScript)) offenders.push("scripts/install.sh: '--adapter pai' flag");
    if (/^\s*pai\)/m.test(installScript)) offenders.push("scripts/install.sh: 'pai)' case branch");
    if (installScript.includes("adapters/pai")) offenders.push("scripts/install.sh: 'adapters/pai' path");
    assertNoOffenders(
      offenders,
      "scripts/install.sh must use the renamed adapter (claudecode), not the old 'pai' name (#59).",
    );
  });
});

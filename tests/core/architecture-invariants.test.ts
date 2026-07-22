import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// Mechanical enforcement of the statically-checkable `core/` invariants that
// AGENTS.md states as prose ("Invariants / must not do"). Prose gets ignored;
// a red test does not. Each assertion below carries a remediation message —
// when the test fails, the error output IS the fix instructions.
//
// Companion to `no-host-strings.test.ts` (broad string scan) — this file is
// import-precise (catches `adapters/**` + host SDK packages a string scan
// misses) and adds the :31337, /tmp, and route-name invariants.

const CORE_DIR = "core";
const ADAPTERS_DIR = "adapters";

/** Every file under `dir` (recursive), skipping installed/linked dependencies. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules") continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(path);
    }
  };
  walk(dir);
  return out;
}

/** Every file under core/ (recursive), so a future subdir is covered too. */
function coreFiles(): string[] {
  return filesUnder(CORE_DIR);
}

/** Runtime TypeScript sources under core/ (excludes JSON config). */
function coreTsFiles(): string[] {
  return coreFiles().filter((f) => f.endsWith(".ts"));
}

/**
 * Import/require/dynamic-import module specifiers in a source file. Comments are
 * stripped first — prose like "distinct from 'failed'" is not an import.
 */
function importSpecifiers(source: string): string[] {
  const content = stripComments(source);
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
 *
 * A block comment collapses to its own newlines rather than to nothing, so line
 * numbers survive the strip — the scans below report `${file}:${i + 1}`, and a
 * 10-line header comment would otherwise shift every diagnostic below it.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, (block) => "\n".repeat(countNewlines(block))) // block comments
    .replace(/(^|[^:])\/\/.*$/gm, "$1"); // line comments, but not `://`
}

function countNewlines(text: string): number {
  return text.length - text.replaceAll("\n", "").length;
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

// ---------------------------------------------------------------------------
// Adapter-side invariants.
//
// The `core/` block above only ever looked outward from the daemon, so two real
// boundary violations lived here for months without turning anything red:
//   - the Pi adapter imported five modules from `../../shared/`, outside its own
//     package root, which no core-only import scan could see;
//   - the Claude Code adapter `readFileSync`'d `core/voices.json`, which even an
//     adapter-side *import* scan would have missed — a filesystem read is not an
//     import. That one needs a string scan.
// Both classes are covered below.
// ---------------------------------------------------------------------------

/** Adapter package roots: every `adapters/<name>/` that ships a package.json. */
function adapterPackages(): { name: string; root: string; manifest: Record<string, any> }[] {
  return readdirSync(ADAPTERS_DIR)
    .map((name) => ({ name, root: join(ADAPTERS_DIR, name) }))
    .filter(({ root }) => statSync(root).isDirectory() && existsSync(join(root, "package.json")))
    .map(({ name, root }) => ({
      name,
      root,
      manifest: JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    }));
}

function adapterTsFiles(root: string): string[] {
  return filesUnder(root).filter((f) => f.endsWith(".ts"));
}

/** Node/Bun builtins an adapter may import without declaring them. */
function isBuiltin(spec: string): boolean {
  return (
    spec.startsWith("node:") ||
    spec === "bun" ||
    spec.startsWith("bun:") ||
    ["fs", "path", "os", "url", "util", "crypto", "child_process", "process"].includes(spec)
  );
}

/** The package name part of a specifier: `@scope/pkg/sub` → `@scope/pkg`. */
function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

describe("adapter package boundary invariants", () => {
  test("every adapters/* package ships a manifest (so its boundary is declarable)", () => {
    const missing = readdirSync(ADAPTERS_DIR)
      .filter((name) => statSync(join(ADAPTERS_DIR, name)).isDirectory())
      .filter((name) => !existsSync(join(ADAPTERS_DIR, name, "package.json")));
    assertNoOffenders(
      missing.map((name) => `adapters/${name}: no package.json`),
      "Every host adapter is a package: it declares what it depends on rather than reaching " +
        "up the tree. Add adapters/<name>/package.json and list it in the root workspaces array.",
    );
  });

  // Invariant 7 — an adapter is self-contained: no relative import escapes its root.
  test("no adapter imports a relative path outside its own package root", () => {
    const offenders: string[] = [];
    for (const { root } of adapterPackages()) {
      const packageRoot = resolve(root);
      for (const file of adapterTsFiles(root)) {
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          if (!spec.startsWith(".")) continue;
          const target = resolve(dirname(file), spec);
          if (target === packageRoot || target.startsWith(packageRoot + "/")) continue;
          offenders.push(`${file}: imports "${spec}" → ${relative(".", target)}, outside ${root}/`);
        }
      }
    }
    assertNoOffenders(
      offenders,
      "A host adapter must be self-contained: every relative import stays inside its own " +
        "package root. Shared behavior belongs in the @echo/shared workspace package, imported " +
        'by name ("@echo/shared/<module>.ts") and declared in the adapter\'s package.json — ' +
        "not reached across the tree with ../../.",
    );
  });

  // Invariant 8 — a bare specifier must be a declared dependency, not an ambient one.
  test("every non-relative adapter import is a builtin or a declared dependency", () => {
    const offenders: string[] = [];
    for (const { root, manifest } of adapterPackages()) {
      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]);
      for (const file of adapterTsFiles(root)) {
        for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
          if (spec.startsWith(".") || isBuiltin(spec)) continue;
          const pkg = packageNameOf(spec);
          if (!declared.has(pkg)) offenders.push(`${file}: imports "${spec}" — ${pkg} is not in ${root}/package.json`);
        }
      }
    }
    assertNoOffenders(
      offenders,
      "An adapter must declare every package it imports in its own package.json " +
        "(dependencies or peerDependencies). An undeclared import resolves only by accident " +
        "of where the checkout happens to sit.",
    );
  });

  // Invariant 9 — adapters reach the daemon over HTTP, never through its files.
  // This is the string-scan companion to the import scans above: the Claude Code
  // adapter's `core/voices.json` read was a filesystem path in a string literal,
  // invisible to any import-based check.
  test("no adapter reads the daemon's core/ files off disk", () => {
    const offenders: string[] = [];
    for (const { root } of adapterPackages()) {
      for (const file of adapterTsFiles(root)) {
        const stripped = stripComments(readFileSync(file, "utf8"));
        stripped.split("\n").forEach((line, i) => {
          // A `core/…` path literal, or a path built from a 'core' segment
          // (join(…, 'core', 'voices.json')).
          if (/["'`][^"'`]*\bcore\/[^"'`]*["'`]/.test(line) || /["']core["']\s*,/.test(line)) {
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    assertNoOffenders(
      offenders,
      "Adapters talk to the daemon over the HTTP contract only — they must not read core/ " +
        "files off disk. A co-located checkout is not part of the contract: the daemon may run " +
        "from another clone or another VOICES_PATH. Ask the daemon instead (GET /voices for " +
        "configured persona keys); see docs/http-api.md.",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT = resolve("adapters/jcode/reconcile.ts");
const HOOK = resolve("adapters/jcode/hook.ts");
const HOOK_COMMAND = `'${HOOK.replaceAll("'", `'\\''`)}'`;

async function run(configPath: string, args: string[] = []) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, JCODE_CONFIG_PATH: configPath },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("Jcode hook registration reconcile", () => {
  test("adds both Echo hooks while preserving unrelated TOML", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-reconcile-"));
    try {
      const path = join(root, "config.toml");
      writeFileSync(path, "[display]\ncentered = true\n");
      expect((await run(path)).exitCode).toBe(0);
      const text = readFileSync(path, "utf8");
      const parsed = Bun.TOML.parse(text) as any;
      expect(parsed.display.centered).toBe(true);
      expect(parsed.hooks.turn_end).toBe(HOOK_COMMAND);
      expect(parsed.hooks.session_start).toBe(HOOK_COMMAND);
      expect((await run(path, ["--check"])).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces stale Echo paths but refuses another owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-stale-"));
    try {
      const path = join(root, "config.toml");
      const staleLink = join(root, "old Echo checkout", "adapters", "jcode", "hook.ts");
      mkdirSync(dirname(staleLink), { recursive: true });
      symlinkSync(HOOK, staleLink);
      writeFileSync(path, `[hooks]\nturn_end = ${JSON.stringify(staleLink)}\nsession_start = ""\n`);
      expect((await run(path)).exitCode).toBe(0);
      expect((Bun.TOML.parse(readFileSync(path, "utf8")) as any).hooks.turn_end).toBe(HOOK_COMMAND);

      writeFileSync(path, '[hooks]\nturn_end = "/usr/local/bin/my-notifier"\n');
      const conflict = await run(path);
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stderr).toContain("already belongs to another command");
      expect(readFileSync(path, "utf8")).toContain("my-notifier");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("handles quoted hooks tables and hashes inside strings", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-quoted-"));
    try {
      const path = join(root, "config.toml");
      writeFileSync(path, '["hooks"] # quoted table\nturn_end = "" # install me\nsession_start = ""\n[ui]\ntheme = "dark#not-comment"\n');
      expect((await run(path)).exitCode).toBe(0);
      const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
      expect(parsed.hooks.turn_end).toBe(HOOK_COMMAND);
      expect(parsed.hooks.session_start).toBe(HOOK_COMMAND);
      expect(parsed.ui.theme).toBe("dark#not-comment");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("inserts missing hooks before a following array table", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-array-boundary-"));
    try {
      const path = join(root, "config.toml");
      writeFileSync(path, '[hooks]\nturn_end = ""\n[[providers]]\nname = "one"\n');
      expect((await run(path)).exitCode).toBe(0);
      const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as any;
      expect(parsed.hooks.turn_end).toBe(HOOK_COMMAND);
      expect(parsed.hooks.session_start).toBe(HOOK_COMMAND);
      expect(parsed.providers).toEqual([{ name: "one" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconciles dotted hook keys without inventing an invalid duplicate table", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-dotted-"));
    try {
      const path = join(root, "config.toml");
      writeFileSync(path, 'hooks.turn_end = ""\nfeatures.memory = true\n');
      expect((await run(path)).exitCode).toBe(0);
      const text = readFileSync(path, "utf8");
      const parsed = Bun.TOML.parse(text) as any;
      expect(parsed.hooks.turn_end).toBe(HOOK_COMMAND);
      expect(parsed.hooks.session_start).toBe(HOOK_COMMAND);
      expect(text).not.toContain("[hooks]");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for inline hooks tables and hooks array tables", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-closed-"));
    try {
      const inline = join(root, "inline.toml");
      writeFileSync(inline, 'hooks = { turn_end = "", session_start = "" }\n');
      const inlineResult = await run(inline);
      expect(inlineResult.exitCode).toBe(2);
      expect(inlineResult.stderr).toContain("inline hooks tables cannot be reconciled safely");

      const array = join(root, "array.toml");
      writeFileSync(array, '[[hooks]]\nturn_end = ""\n');
      const arrayResult = await run(array);
      expect(arrayResult.exitCode).toBe(2);
      expect(arrayResult.stderr).toContain("must be a table");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses foreign paths that merely end with adapters/jcode/hook.ts", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-foreign-"));
    try {
      const foreign = join(root, "foreign", "adapters", "jcode", "hook.ts");
      const path = join(root, "config.toml");
      mkdirSync(dirname(foreign), { recursive: true });
      writeFileSync(foreign, "#!/usr/bin/env bun\n");
      writeFileSync(path, `[hooks]\nturn_end = ${JSON.stringify(foreign)}\n`);
      const result = await run(path);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("already belongs to another command");
      expect(readFileSync(path, "utf8")).toContain(foreign);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check mode is read-only and reports pending changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-check-"));
    try {
      const path = join(root, "config.toml");
      const original = "[features]\nmemory = true\n";
      writeFileSync(path, original);
      const result = await run(path, ["--check"]);
      expect(result.exitCode).toBe(3);
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("edits through a symlink without replacing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-symlink-"));
    try {
      const nominal = join(root, ".jcode", "config.toml");
      const real = join(root, "dotfiles", "jcode.toml");
      mkdirSync(dirname(nominal), { recursive: true });
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, "[features]\nswarm = true\n");
      symlinkSync(relative(dirname(nominal), real), nominal);

      expect((await run(nominal)).exitCode).toBe(0);
      expect(lstatSync(nominal).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nominal)).toBe(relative(dirname(nominal), real));
      expect((Bun.TOML.parse(readFileSync(real, "utf8")) as any).hooks.turn_end).toBe(HOOK_COMMAND);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a dead config symlink without replacing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-dead-symlink-"));
    try {
      const path = join(root, "config.toml");
      symlinkSync("missing.toml", path);
      const result = await run(path);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("dead symlink");
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

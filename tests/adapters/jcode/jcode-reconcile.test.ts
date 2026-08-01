import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT = resolve("adapters/jcode/reconcile.ts");
const HOOK = resolve("adapters/jcode/hook.ts");

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
      expect(parsed.hooks.turn_end).toBe(HOOK);
      expect(parsed.hooks.session_start).toBe(HOOK);
      expect((await run(path, ["--check"])).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces stale Echo paths but refuses another owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-jcode-stale-"));
    try {
      const path = join(root, "config.toml");
      writeFileSync(path, '[hooks]\nturn_end = "/old/clone/adapters/jcode/hook.ts"\nsession_start = ""\n');
      expect((await run(path)).exitCode).toBe(0);
      expect((Bun.TOML.parse(readFileSync(path, "utf8")) as any).hooks.turn_end).toBe(HOOK);

      writeFileSync(path, '[hooks]\nturn_end = "/usr/local/bin/my-notifier"\n');
      const conflict = await run(path);
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stderr).toContain("already belongs to another command");
      expect(readFileSync(path, "utf8")).toContain("my-notifier");
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
      expect((Bun.TOML.parse(readFileSync(real, "utf8")) as any).hooks.turn_end).toBe(HOOK);
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

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("adapters/opencode/reconcile.ts");
const PLUGIN = realpathSync(resolve("adapters/opencode/plugin.ts"));
const LINK_NAME = "echo-voice.ts";

async function runReconcile(pluginsDir: string, args: string[] = []) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, ECHO_OPENCODE_PLUGINS_DIR: pluginsDir },
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

async function withPluginsDir(fn: (dir: string) => Promise<void>) {
  const dir = join(mkdtempSync(join(tmpdir(), "echo-opencode-plugins-")), "plugins");
  try {
    await fn(dir);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

describe("OpenCode plugin registration reconcile", () => {
  test("creates the canonical symlink when absent", async () => {
    await withPluginsDir(async (dir) => {
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      const link = join(dir, LINK_NAME);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(PLUGIN);
    });
  });

  test("is idempotent - rerun on a correct link changes nothing", async () => {
    await withPluginsDir(async (dir) => {
      await runReconcile(dir);
      const second = await runReconcile(dir);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already");
      const check = await runReconcile(dir, ["--check"]);
      expect(check.exitCode).toBe(0);
    });
  });

  test("heals a dead Echo plugin symlink from a renamed clone", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      symlinkSync("/old/clone/adapters/opencode/plugin.ts", join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(PLUGIN);
    });
  });

  test("re-points a live Echo plugin symlink from another clone", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const other = join(dir, "other-clone", "adapters", "opencode");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "plugin.ts"), "export {}\n");
      writeFileSync(join(other, "package.json"), `${JSON.stringify({ name: "@echo/opencode-adapter" })}\n`);
      symlinkSync(join(other, "plugin.ts"), join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(realpathSync(join(dir, LINK_NAME))).toBe(PLUGIN);
    });
  });

  test("refuses a live non-Echo adapters/opencode/plugin.ts occupying the canonical name", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const other = join(dir, "otherproject", "adapters", "opencode");
      mkdirSync(other, { recursive: true });
      writeFileSync(join(other, "plugin.ts"), "export {}\n");
      writeFileSync(join(other, "package.json"), `${JSON.stringify({ name: "not-echo" })}\n`);
      const foreign = join(other, "plugin.ts");
      symlinkSync(foreign, join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(foreign);
    });
  });

  test("leaves unrelated plugin entries alone", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "statusline.ts"), "// someone else's plugin\n");
      symlinkSync("/somewhere/else/tool.ts", join(dir, "other-plugin.ts"));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "statusline.ts"))).toBe(true);
      expect(lstatSync(join(dir, "other-plugin.ts")).isSymbolicLink()).toBe(true);
    });
  });

  test("--check reports pending changes with exit 3 and does not mutate", async () => {
    await withPluginsDir(async (dir) => {
      const result = await runReconcile(dir, ["--check"]);
      expect(result.exitCode).toBe(3);
      expect(existsSync(join(dir, LINK_NAME))).toBe(false);
    });
  });

  test("--check surfaces a FATAL state with exit 2 and does not mutate", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(join(dir, LINK_NAME), { recursive: true });
      const result = await runReconcile(dir, ["--check"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(lstatSync(join(dir, LINK_NAME)).isDirectory()).toBe(true);
    });
  });

  test("refuses to replace an unrelated symlink occupying the canonical name", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      symlinkSync("/somewhere/else/tool.ts", join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(readlinkSync(join(dir, LINK_NAME))).toBe("/somewhere/else/tool.ts");
    });
  });

  test("refuses to replace a non-symlink occupying the canonical name", async () => {
    await withPluginsDir(async (dir) => {
      mkdirSync(join(dir, LINK_NAME), { recursive: true });
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(lstatSync(join(dir, LINK_NAME)).isDirectory()).toBe(true);
    });
  });
});

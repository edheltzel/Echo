import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("adapters/pi/reconcile-omp.ts");
const ADAPTER_DIR = resolve("adapters/pi");
const LINK_NAME = "echo-voice";

async function runReconcile(extensionsDir: string, args: string[] = []) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, OMP_EXTENSIONS_DIR: extensionsDir },
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

function tempExtensionsDir(): string {
  return join(mkdtempSync(join(tmpdir(), "echo-omp-reconcile-")), "extensions");
}

describe("omp extension registration reconcile", () => {
  test("creates the canonical symlink when absent", async () => {
    const dir = tempExtensionsDir();
    try {
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      const link = join(dir, LINK_NAME);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(ADAPTER_DIR);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("is idempotent — rerun on a correct dir changes nothing", async () => {
    const dir = tempExtensionsDir();
    try {
      await runReconcile(dir);
      const second = await runReconcile(dir);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already");
      const check = await runReconcile(dir, ["--check"]);
      expect(check.exitCode).toBe(0);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("prunes a stale symlink from a renamed clone and keeps one canonical link", async () => {
    const dir = tempExtensionsDir();
    try {
      mkdirSync(dir, { recursive: true });
      // Dead path from a renamed repo directory — matches */adapters/pi but resolves nowhere.
      symlinkSync("/nonexistent/oldclone/adapters/pi", join(dir, "echo-old"));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "echo-old"))).toBe(false);
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(ADAPTER_DIR);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("removes a duplicate live link under a different name", async () => {
    const dir = tempExtensionsDir();
    try {
      mkdirSync(dir, { recursive: true });
      symlinkSync(ADAPTER_DIR, join(dir, "echo-duplicate"));
      symlinkSync(ADAPTER_DIR, join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(lstatSync(join(dir, LINK_NAME)).isSymbolicLink()).toBe(true);
      expect(existsSync(join(dir, "echo-duplicate"))).toBe(false);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("--check reports pending changes with exit 3 and does not mutate", async () => {
    const dir = tempExtensionsDir();
    try {
      const result = await runReconcile(dir, ["--check"]);
      expect(result.exitCode).toBe(3);
      expect(existsSync(join(dir, LINK_NAME))).toBe(false);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("leaves unrelated extension entries alone", async () => {
    const dir = tempExtensionsDir();
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "statusline.ts"), "// someone else's extension\n");
      symlinkSync("/somewhere/else/tool", join(dir, "other-tool"));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "statusline.ts"))).toBe(true);
      expect(lstatSync(join(dir, "other-tool")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("refuses to replace an unrelated symlink occupying the canonical name", async () => {
    const dir = tempExtensionsDir();
    try {
      mkdirSync(dir, { recursive: true });
      symlinkSync("/somewhere/else/tool", join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(readlinkSync(join(dir, LINK_NAME))).toBe("/somewhere/else/tool");
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });

  test("refuses to replace a non-symlink occupying the canonical name", async () => {
    const dir = tempExtensionsDir();
    try {
      mkdirSync(join(dir, LINK_NAME), { recursive: true });
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(lstatSync(join(dir, LINK_NAME)).isDirectory()).toBe(true);
    } finally {
      rmSync(join(dir, ".."), { recursive: true, force: true });
    }
  });
});

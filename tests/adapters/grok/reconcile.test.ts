import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT = resolve("adapters/grok/reconcile.ts");
const HOOK = resolve("adapters/grok/hook.ts");

async function run(hooksDir: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    env: { ...process.env, ECHO_GROK_HOOKS_DIR: hooksDir, ...extraEnv },
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

describe("Grok hook registration reconcile", () => {
  test("adds echo-voice.json while preserving foreign siblings including fm-turn-end", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-reconcile-"));
    try {
      const hooksDir = join(root, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const foreignJson = join(hooksDir, "fm-turn-end.json");
      const foreignSh = join(hooksDir, "fm-turn-end.sh");
      const foreignBody = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash \'/tmp/fm-turn-end.sh\'"}]}]}}\n';
      const foreignScript = "#!/bin/bash\nexit 0\n";
      writeFileSync(foreignJson, foreignBody);
      writeFileSync(foreignSh, foreignScript);

      expect((await run(hooksDir)).exitCode).toBe(0);
      const owned = join(hooksDir, "echo-voice.json");
      expect(readFileSync(owned, "utf8")).toContain("adapters/grok/hook.ts");
      expect(readFileSync(owned, "utf8")).toContain(HOOK);
      // Foreign firstmate files must be byte-identical.
      expect(readFileSync(foreignJson, "utf8")).toBe(foreignBody);
      expect(readFileSync(foreignSh, "utf8")).toBe(foreignScript);
      expect((await run(hooksDir, ["--check"])).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces stale Echo paths but refuses a foreign owner of echo-voice.json", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-stale-"));
    try {
      const hooksDir = join(root, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const owned = join(hooksDir, "echo-voice.json");
      writeFileSync(
        owned,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "bun '/old/clone/adapters/grok/hook.ts'" }] }],
          },
        }) + "\n",
      );
      expect((await run(hooksDir)).exitCode).toBe(0);
      expect(readFileSync(owned, "utf8")).toContain(HOOK);

      writeFileSync(owned, '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/usr/local/bin/my-notifier"}]}]}}\n');
      const conflict = await run(hooksDir);
      expect(conflict.exitCode).toBe(2);
      expect(conflict.stderr).toContain("does not own");
      expect(readFileSync(owned, "utf8")).toContain("my-notifier");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check mode is read-only and reports pending changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-check-"));
    try {
      const hooksDir = join(root, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      const result = await run(hooksDir, ["--check"]);
      expect(result.exitCode).toBe(3);
      expect(readFileSync).toBeDefined();
      // No owned file created in check mode.
      try {
        readFileSync(join(hooksDir, "echo-voice.json"));
        expect.unreachable("echo-voice.json must not exist after --check");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors GROK_HOME when ECHO_GROK_HOOKS_DIR is unset", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-home-"));
    try {
      const grokHome = join(root, "grokhome");
      const hooksDir = join(grokHome, "hooks");
      const proc = Bun.spawn(["bun", "run", SCRIPT], {
        env: {
          ...process.env,
          GROK_HOME: grokHome,
          // Ensure the explicit override is absent.
          ECHO_GROK_HOOKS_DIR: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Delete empty override so resolve uses GROK_HOME
      // (empty string is still set - spawn with filtered env instead)
      await proc.exited;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const root2 = mkdtempSync(join(tmpdir(), "echo-grok-home2-"));
    try {
      const grokHome = join(root2, "grokhome");
      const env = { ...process.env, GROK_HOME: grokHome };
      delete env.ECHO_GROK_HOOKS_DIR;
      const proc = Bun.spawn(["bun", "run", SCRIPT], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      expect(exitCode).toBe(0);
      const owned = readFileSync(join(grokHome, "hooks", "echo-voice.json"), "utf8");
      expect(owned).toContain("adapters/grok/hook.ts");
    } finally {
      rmSync(root2, { recursive: true, force: true });
    }
  });

  test("edits through a symlink without replacing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-symlink-"));
    try {
      const hooksDir = join(root, "hooks");
      const realDir = join(root, "dotfiles", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      mkdirSync(realDir, { recursive: true });
      const real = join(realDir, "echo-voice.json");
      const nominal = join(hooksDir, "echo-voice.json");
      writeFileSync(
        real,
        JSON.stringify({
          hooks: {
            Stop: [{ hooks: [{ type: "command", command: "bun '/old/adapters/grok/hook.ts'" }] }],
          },
        }) + "\n",
      );
      symlinkSync(relative(hooksDir, real), nominal);

      expect((await run(hooksDir)).exitCode).toBe(0);
      expect(lstatSync(nominal).isSymbolicLink()).toBe(true);
      expect(readlinkSync(nominal)).toBe(relative(hooksDir, real));
      expect(readFileSync(real, "utf8")).toContain(HOOK);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a dead owned symlink without replacing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-dead-symlink-"));
    try {
      const hooksDir = join(root, "hooks");
      mkdirSync(hooksDir, { recursive: true });
      symlinkSync("missing.json", join(hooksDir, "echo-voice.json"));
      const result = await run(hooksDir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("dead symlink");
      expect(lstatSync(join(hooksDir, "echo-voice.json")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

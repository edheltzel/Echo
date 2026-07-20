import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("adapters/omp/reconcile.ts");
// The script canonicalizes via realpathSync; match it so the suite passes on
// checkouts reached through a symlinked path component.
const ADAPTER_DIR = realpathSync(resolve("adapters/omp"));
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

async function withExtensionsDir(fn: (dir: string) => Promise<void>) {
  const dir = tempExtensionsDir();
  try {
    await fn(dir);
  } finally {
    rmSync(join(dir, ".."), { recursive: true, force: true });
  }
}

describe("omp extension registration reconcile (adapters/omp)", () => {
  test("creates the canonical symlink → adapters/omp when absent", async () => {
    await withExtensionsDir(async (dir) => {
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      const link = join(dir, LINK_NAME);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readlinkSync(link)).toBe(ADAPTER_DIR);
    });
  });

  test("is idempotent — rerun on a correct dir changes nothing", async () => {
    await withExtensionsDir(async (dir) => {
      await runReconcile(dir);
      const second = await runReconcile(dir);
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already");
      const check = await runReconcile(dir, ["--check"]);
      expect(check.exitCode).toBe(0);
    });
  });

  // #109 migration: an existing Echo echo-voice link pointing at the pre-split
  // shared adapters/pi (live @echo/pi-adapter) is migrated onto adapters/omp.
  test("MIGRATES a live echo-voice link from adapters/pi (@echo/pi-adapter) to adapters/omp", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const sharedPi = join(dir, "..", "echo-clone", "adapters", "pi");
      mkdirSync(sharedPi, { recursive: true });
      writeFileSync(join(sharedPi, "package.json"), JSON.stringify({ name: "@echo/pi-adapter" }));
      symlinkSync(sharedPi, join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("migrating from adapters/pi");
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(ADAPTER_DIR);
    });
  });

  test("heals a dead echo-voice link from a renamed clone (pi or omp spelling)", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      symlinkSync("/nonexistent/oldclone/adapters/pi", join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(ADAPTER_DIR);
    });
  });

  test("re-points a live echo-voice link into another omp clone (@echo/omp-adapter)", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const otherClone = join(dir, "..", "otherclone", "adapters", "omp");
      mkdirSync(otherClone, { recursive: true });
      writeFileSync(join(otherClone, "package.json"), JSON.stringify({ name: "@echo/omp-adapter" }));
      symlinkSync(otherClone, join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(ADAPTER_DIR);
    });
  });

  // A LIVE user-owned symlink under a foreign name whose target ends in
  // adapters/omp must never be pruned (#77 / PR #80 finding 1).
  test("leaves a live foreign-named link with an adapters/omp target untouched", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const otherProject = join(dir, "..", "otherproject", "adapters", "omp");
      mkdirSync(otherProject, { recursive: true });
      symlinkSync(otherProject, join(dir, "my-other-echo"));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(readlinkSync(join(dir, "my-other-echo"))).toBe(otherProject);
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(ADAPTER_DIR);
    });
  });

  // A live-foreign link OCCUPYING echo-voice — adapters/omp spelling but not an
  // Echo checkout — is FATAL, never silently replaced.
  test("refuses a live non-Echo adapters/omp target occupying the canonical name", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      const otherProject = join(dir, "..", "otherproject", "adapters", "omp");
      mkdirSync(otherProject, { recursive: true }); // no @echo/*-adapter package.json
      symlinkSync(otherProject, join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(readlinkSync(join(dir, LINK_NAME))).toBe(otherProject);
    });
  });

  test("--check reports pending changes with exit 3 and does not mutate", async () => {
    await withExtensionsDir(async (dir) => {
      const result = await runReconcile(dir, ["--check"]);
      expect(result.exitCode).toBe(3);
      expect(existsSync(join(dir, LINK_NAME))).toBe(false);
    });
  });

  test("--check surfaces a FATAL state with exit 2 and does not mutate", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(join(dir, LINK_NAME), { recursive: true });
      const result = await runReconcile(dir, ["--check"]);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(lstatSync(join(dir, LINK_NAME)).isDirectory()).toBe(true);
    });
  });

  test("leaves unrelated extension entries alone", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "statusline.ts"), "// someone else's extension\n");
      symlinkSync("/somewhere/else/tool", join(dir, "other-tool"));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(dir, "statusline.ts"))).toBe(true);
      expect(lstatSync(join(dir, "other-tool")).isSymbolicLink()).toBe(true);
    });
  });

  test("refuses to replace an unrelated symlink occupying the canonical name", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(dir, { recursive: true });
      symlinkSync("/somewhere/else/tool", join(dir, LINK_NAME));
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(readlinkSync(join(dir, LINK_NAME))).toBe("/somewhere/else/tool");
    });
  });

  test("refuses to replace a non-symlink occupying the canonical name", async () => {
    await withExtensionsDir(async (dir) => {
      mkdirSync(join(dir, LINK_NAME), { recursive: true });
      const result = await runReconcile(dir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("FATAL");
      expect(lstatSync(join(dir, LINK_NAME)).isDirectory()).toBe(true);
    });
  });
});

import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const CANONICAL_ADAPTER_DIR = resolve("adapters/pi");

async function runReconcile(settingsPath: string, extraArgs: string[] = []) {
  const proc = Bun.spawn(["bun", "run", "adapters/pi/reconcile.ts", ...extraArgs], {
    env: { ...process.env, PI_SETTINGS_PATH: settingsPath },
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

function writeSettings(path: string, packages: string[]): string {
  const content = JSON.stringify({ packages, theme: "dark" }, null, 2) + "\n";
  writeFileSync(path, content);
  return content;
}

describe("Pi adapter registration reconcile", () => {
  test("replaces a stale renamed-clone entry with the canonical path in place (#77)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-pi-reconcile-stale-"));
    try {
      const settingsPath = join(root, "settings.json");
      writeSettings(settingsPath, [
        "npm:pi-mcp-adapter",
        "../../Developer/atlas-voicesystem/adapters/pi",
        "npm:pi-subagents",
      ]);

      const first = await runReconcile(settingsPath);
      const second = await runReconcile(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const canonical = relative(root, CANONICAL_ADAPTER_DIR);

      expect(first.exitCode).toBe(0);
      // Replaced in place — same position, npm entries untouched, no duplicate appended.
      expect(settings.packages).toEqual(["npm:pi-mcp-adapter", canonical, "npm:pi-subagents"]);
      expect(settings.theme).toBe("dark");
      // Second run is a no-op.
      expect(second.exitCode).toBe(0);
      expect(second.stdout).toContain("already current");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("collapses stale + canonical pair down to the single canonical entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-pi-reconcile-dup-"));
    try {
      const settingsPath = join(root, "settings.json");
      const canonical = relative(root, CANONICAL_ADAPTER_DIR);
      writeSettings(settingsPath, [
        "/dead/old-clone/adapters/pi",
        canonical,
        "npm:pi-web-access",
      ]);

      const result = await runReconcile(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));

      expect(result.exitCode).toBe(0);
      expect(settings.packages.filter((p: string) => p.endsWith("/adapters/pi"))).toHaveLength(1);
      expect(settings.packages).toContain("npm:pi-web-access");
      expect(settings.packages).not.toContain("/dead/old-clone/adapters/pi");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("appends the canonical entry when no adapters/pi entry exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-pi-reconcile-fresh-"));
    try {
      const settingsPath = join(root, "settings.json");
      writeSettings(settingsPath, ["npm:pi-mcp-adapter"]);

      const result = await runReconcile(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const canonical = relative(root, CANONICAL_ADAPTER_DIR);

      expect(result.exitCode).toBe(0);
      expect(settings.packages).toEqual(["npm:pi-mcp-adapter", canonical]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("edits through a symlinked settings.json without replacing the symlink (#77)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-pi-reconcile-symlink-"));
    try {
      // Mirror the dotfiles layout: ~/.pi/agent/settings.json -> ../../dotfiles/.../settings.json
      const nominalDir = join(root, "pi/agent");
      const dotfilesDir = join(root, "dotfiles/pi/agent");
      mkdirSync(nominalDir, { recursive: true });
      mkdirSync(dotfilesDir, { recursive: true });
      const realFile = join(dotfilesDir, "settings.json");
      const linkPath = join(nominalDir, "settings.json");
      writeSettings(realFile, ["/dead/old-clone/adapters/pi"]);
      const linkTarget = relative(nominalDir, realFile);
      symlinkSync(linkTarget, linkPath);

      const result = await runReconcile(linkPath);

      expect(result.exitCode).toBe(0);
      // Still the same symlink, pointing at the same target.
      expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(linkPath)).toBe(linkTarget);
      // Content updated through the link; canonical path is relative to the NOMINAL
      // directory (where Pi resolves it from), not the symlink target's directory.
      const settings = JSON.parse(readFileSync(realFile, "utf8"));
      expect(settings.packages).toEqual([relative(nominalDir, CANONICAL_ADAPTER_DIR)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--check reports a stale entry without mutating", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-pi-reconcile-check-"));
    try {
      const settingsPath = join(root, "settings.json");
      const original = writeSettings(settingsPath, ["/dead/old-clone/adapters/pi"]);

      const result = await runReconcile(settingsPath, ["--check"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("would be updated");
      expect(result.stdout).toContain("/dead/old-clone/adapters/pi");
      expect(readFileSync(settingsPath, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exits cleanly when no Pi settings file exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-pi-reconcile-missing-"));
    try {
      const result = await runReconcile(join(root, "settings.json"));
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("nothing to reconcile");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function runRestore(settingsPath: string, extraArgs: string[] = []) {
  const proc = Bun.spawn(["bun", "run", "adapters/pai/restore-hooks.ts", ...extraArgs], {
    env: { ...process.env, PAI_SETTINGS_PATH: settingsPath },
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

describe("PAI restore-hooks migration", () => {
  test("restore wrapper delegates to the adapter script", () => {
    const wrapper = readFileSync("scripts/restore-hooks.ts", "utf8");
    expect(wrapper).toContain("adapters/pai/restore-hooks.ts");
  });

  test("adapter restore script derives new hook paths from import.meta.url", () => {
    const script = readFileSync("adapters/pai/restore-hooks.ts", "utf8");
    expect(script).toContain("fileURLToPath(import.meta.url)");
    expect(script).toContain("HISTORICAL_REPO_ROOT");
    expect(script).not.toContain('"Developer/atlas-voicesystem/adapters/pai/hooks"');
  });

  test("check mode validates without writing settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-restore-check-"));
    try {
      const settingsPath = join(root, "settings.json");
      const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }, null, 2) + "\n";
      writeFileSync(settingsPath, original, { mode: 0o644 });

      const result = await runRestore(settingsPath, ["--check"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("preflight passed");
      expect(readFileSync(settingsPath, "utf8")).toBe(original);
      expect(existsSync(`${settingsPath}.bak`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes dynamic adapter paths and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-restore-write-"));
    try {
      const settingsPath = join(root, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }, null, 2) + "\n", { mode: 0o644 });

      const first = await runRestore(settingsPath);
      const second = await runRestore(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const expectedHooksDir = resolve("adapters/pai/hooks");

      expect(first.exitCode).toBe(0);
      expect(second.exitCode).toBe(0);
      expect(settings.hooks.PreToolUse[0].hooks).toEqual([
        { type: "command", command: join(expectedHooksDir, "VoiceGate.hook.ts") },
      ]);
      expect(settings.hooks.SessionStart[0].hooks).toEqual([
        { type: "command", command: join(expectedHooksDir, "VoiceGreeting.hook.ts") },
      ]);
      expect(second.stdout).toContain("already current");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails clearly when the Bash matcher is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-restore-missing-bash-"));
    try {
      const settingsPath = join(root, "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ hooks: { PreToolUse: [] } }, null, 2) + "\n");

      const result = await runRestore(settingsPath, ["--check"]);

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("no PreToolUse matcher='Bash'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("replaces the unmanaged Stop VoiceCompletion hook with the repo copy and is idempotent", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-restore-stop-"));
    try {
      const settingsPath = join(root, "settings.json");
      const unmanaged = join(process.env.HOME ?? "", ".claude/hooks/VoiceCompletion.hook.ts");
      writeFileSync(
        settingsPath,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [{ matcher: "Bash", hooks: [] }],
              Stop: [
                {
                  hooks: [
                    { type: "command", command: "/some/LastResponseCache.hook.ts" },
                    { type: "command", command: unmanaged },
                    { type: "command", command: "/some/DocIntegrity.hook.ts" },
                  ],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
        { mode: 0o644 },
      );

      const first = await runRestore(settingsPath);
      const second = await runRestore(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const repoCmd = join(resolve("adapters/pai/hooks"), "VoiceCompletion.hook.ts");

      expect(first.exitCode).toBe(0);
      // Replaced in place — same position, no duplicate added.
      expect(settings.hooks.Stop[0].hooks).toEqual([
        { type: "command", command: "/some/LastResponseCache.hook.ts" },
        { type: "command", command: repoCmd },
        { type: "command", command: "/some/DocIntegrity.hook.ts" },
      ]);
      expect(first.stdout).toContain("VoiceCompletion.hook.ts → repo copy");
      expect(second.stdout).toContain("already points VoiceCompletion.hook.ts at repo copy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("registers the Stop VoiceCompletion hook when none exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-restore-stop-fresh-"));
    try {
      const settingsPath = join(root, "settings.json");
      writeFileSync(
        settingsPath,
        JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } }, null, 2) + "\n",
        { mode: 0o644 },
      );

      await runRestore(settingsPath);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const repoCmd = join(resolve("adapters/pai/hooks"), "VoiceCompletion.hook.ts");

      const stopCommands = settings.hooks.Stop.flatMap((entry: { hooks: { command: string }[] }) =>
        entry.hooks.map((h) => h.command),
      );
      expect(stopCommands).toContain(repoCmd);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

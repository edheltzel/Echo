import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RECONCILE = resolve("adapters/claudecode/reconcile-commands.ts");
const SOURCES = resolve("adapters/claudecode/commands");
const COMMAND_NAMES = ["echo-mute.md", "echo-voice.md"];

function runReconcile(commandsDir: string, check = false) {
  const result = Bun.spawnSync([process.execPath, RECONCILE, ...(check ? ["--check"] : [])], {
    env: { ...process.env, ECHO_CLAUDE_COMMANDS_DIR: commandsDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("Claude Code slash-command reconciliation", () => {
  test("reports pending links, creates them, and becomes current", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-commands-"));
    const commands = join(root, "commands");
    try {
      const pending = runReconcile(commands, true);
      expect(pending.exitCode).toBe(3);
      expect(existsSync(commands)).toBe(false);

      const installed = runReconcile(commands);
      expect(installed.exitCode, installed.stderr).toBe(0);
      for (const name of COMMAND_NAMES) {
        expect(lstatSync(join(commands, name)).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(commands, name))).toBe(realpathSync(join(SOURCES, name)));
      }

      const current = runReconcile(commands, true);
      expect(current.exitCode, current.stderr).toBe(0);
      expect(current.stdout).toContain("commands already current");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a foreign command without partially creating another link", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-commands-foreign-"));
    const commands = join(root, "commands");
    try {
      mkdirSync(commands, { recursive: true });
      const foreign = join(commands, "echo-voice.md");
      writeFileSync(foreign, "third-party command\n");

      const result = runReconcile(commands);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("will not overwrite");
      expect(readFileSync(foreign, "utf8")).toBe("third-party command\n");
      expect(existsSync(join(commands, "echo-mute.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("check preserves and install heals stale Echo-owned links", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-commands-stale-"));
    const commands = join(root, "commands");
    try {
      mkdirSync(commands, { recursive: true });
      for (const name of COMMAND_NAMES) {
        symlinkSync(`/old/clone/adapters/claudecode/commands/${name}`, join(commands, name));
      }

      const pending = runReconcile(commands, true);
      expect(pending.exitCode).toBe(3);
      expect(readlinkSync(join(commands, "echo-mute.md"))).toContain("/old/clone/");

      const healed = runReconcile(commands);
      expect(healed.exitCode, healed.stderr).toBe(0);
      for (const name of COMMAND_NAMES) {
        expect(readlinkSync(join(commands, name))).toBe(realpathSync(join(SOURCES, name)));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

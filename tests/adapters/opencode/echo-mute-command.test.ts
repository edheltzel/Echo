import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RECONCILE = resolve("adapters/opencode/reconcile.ts");
const SOURCE = resolve("adapters/opencode/commands/echo-mute.md");

function runReconcile(commandsDir: string, check = false) {
  const result = Bun.spawnSync([process.execPath, RECONCILE, ...(check ? ["--check"] : [])], {
    env: { ...process.env, ECHO_OPENCODE_COMMANDS_DIR: commandsDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

describe("OpenCode /echo-mute", () => {
  test("command file drives bash cli/echo mute and never Bun or POST /mute", () => {
    expect(existsSync(SOURCE)).toBe(true);
    const md = readFileSync(SOURCE, "utf8");
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).not.toContain("Bun.spawn");
    expect(md).not.toMatch(/POST\s+\/mute/);
  });

  test("reconcile creates the link and becomes current", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-opencode-commands-"));
    const commands = join(root, "commands");
    try {
      expect(runReconcile(commands, true).exitCode).toBe(3);
      expect(runReconcile(commands).exitCode).toBe(0);
      expect(lstatSync(join(commands, "echo-mute.md")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(commands, "echo-mute.md"))).toBe(realpathSync(SOURCE));
      expect(runReconcile(commands, true).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a foreign command without mutating it", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-opencode-commands-foreign-"));
    const commands = join(root, "commands");
    try {
      mkdirSync(commands, { recursive: true });
      const foreign = join(commands, "echo-mute.md");
      writeFileSync(foreign, "third-party command\n");
      const result = runReconcile(commands);
      expect(result.exitCode).toBe(2);
      expect(readFileSync(foreign, "utf8")).toBe("third-party command\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

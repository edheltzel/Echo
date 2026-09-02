import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

describe("OpenCode /echo-mute command file", () => {
  test("drives bash cli/echo mute and never Bun or POST /mute", () => {
    expect(existsSync(SOURCE)).toBe(true);
    const md = readFileSync(SOURCE, "utf8");
    expect(md).toContain('ARGS="$ARGUMENTS"');
    expect(md).toContain('[ -n "$ARGS" ] || ARGS=toggle');
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).toContain("cli/echo");
    expect(md).not.toContain("Bun.spawn");
    expect(md).not.toMatch(/POST\s+\/mute/);
    expect(md).not.toMatch(/curl[^\n]*\/mute/);
  });

  test("forwards a non-empty argument and defaults empty input to toggle", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-opencode-mute-command-"));
    try {
      const repo = join(root, "repo");
      const source = join(repo, "adapters/opencode/commands/echo-mute.md");
      const commands = join(root, "home/.config/opencode/commands");
      const cli = join(repo, "cli/echo");
      const log = join(root, "args.log");
      mkdirSync(join(repo, "adapters/opencode/commands"), { recursive: true });
      mkdirSync(commands, { recursive: true });
      mkdirSync(join(repo, "cli"), { recursive: true });
      const md = readFileSync(SOURCE, "utf8");
      writeFileSync(source, md);
      symlinkSync(source, join(commands, "echo-mute.md"));
      writeFileSync(cli, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });

      for (const [argument, expected] of [["toggle", "mute\ntoggle\n"], ["", "mute\ntoggle\n"]]) {
        const rendered = md.replaceAll("$ARGUMENTS", argument);
        const block = rendered.match(/```bash\n([\s\S]*?)\n```/)?.[1];
        if (!block) throw new Error("missing bash block");
        const result = Bun.spawnSync(["/bin/bash", "-c", block], {
          env: { HOME: join(root, "home"), PATH: "/bin:/usr/bin" },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(readFileSync(log, "utf8")).toBe(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("OpenCode mute-command reconciliation", () => {
  test("reports pending links, creates them, and becomes current", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-opencode-commands-"));
    const commands = join(root, "commands");
    try {
      const pending = runReconcile(commands, true);
      expect(pending.exitCode).toBe(3);
      expect(existsSync(commands)).toBe(false);

      const installed = runReconcile(commands);
      expect(installed.exitCode, installed.stderr).toBe(0);
      expect(lstatSync(join(commands, "echo-mute.md")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(commands, "echo-mute.md"))).toBe(realpathSync(SOURCE));

      const current = runReconcile(commands, true);
      expect(current.exitCode, current.stderr).toBe(0);
      expect(current.stdout).toContain("already current");
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
      expect(result.stderr).toContain("will not overwrite");
      expect(readFileSync(foreign, "utf8")).toBe("third-party command\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("heals a stale Echo-owned link", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-opencode-commands-stale-"));
    const commands = join(root, "commands");
    try {
      mkdirSync(commands, { recursive: true });
      symlinkSync("/old/clone/adapters/opencode/commands/echo-mute.md", join(commands, "echo-mute.md"));

      const pending = runReconcile(commands, true);
      expect(pending.exitCode).toBe(3);
      expect(readlinkSync(join(commands, "echo-mute.md"))).toContain("/old/clone/");

      const healed = runReconcile(commands);
      expect(healed.exitCode, healed.stderr).toBe(0);
      expect(readlinkSync(join(commands, "echo-mute.md"))).toBe(realpathSync(SOURCE));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

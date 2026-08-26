import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMANDS = "adapters/claudecode/commands";

describe("claude /echo-mute command file", () => {
  test("sits beside /echo-voice and drives cli/echo mute", () => {
    expect(readdirSync(COMMANDS).sort()).toEqual(["echo-mute.md", "echo-voice.md"]);
    expect(existsSync(join(COMMANDS, "echo-mute.md"))).toBe(true);
    const md = readFileSync(join(COMMANDS, "echo-mute.md"), "utf8");
    expect(md).toContain('ARGS="${1:-status}"');
    expect(md).not.toContain("${ARGUMENTS:-status}");
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).toContain("cli/echo");
    expect(md).toContain("argument-hint: [on|off|toggle|status|duration]");
  });

  test("forwards a non-empty argument and defaults empty input to status", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-mute-command-"));
    try {
      const repo = join(root, "repo");
      const source = join(repo, "adapters/claudecode/commands/echo-mute.md");
      const commands = join(root, "home/.claude/commands");
      const cli = join(repo, "cli/echo");
      const log = join(root, "args.log");
      mkdirSync(join(repo, "adapters/claudecode/commands"), { recursive: true });
      mkdirSync(commands, { recursive: true });
      mkdirSync(join(repo, "cli"), { recursive: true });
      const md = readFileSync(join(COMMANDS, "echo-mute.md"), "utf8");
      writeFileSync(source, md);
      symlinkSync(source, join(commands, "echo-mute.md"));
      writeFileSync(cli, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });

      for (const [argument, expected] of [["toggle", "mute\ntoggle\n"], ["", "mute\nstatus\n"]]) {
        const rendered = md
          .replace(/\$\{1:-([^}]+)\}/g, (_match, fallback: string) => argument || fallback)
          .replaceAll("$ARGUMENTS", argument);
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

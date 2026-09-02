import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILL = "adapters/grok/skills/echo-mute/SKILL.md";

describe("grok /echo-mute skill", () => {
  test("drives bash cli/echo mute and never Bun or POST /mute", () => {
    expect(existsSync(SKILL)).toBe(true);
    const md = readFileSync(SKILL, "utf8");
    expect(md).toContain("user-invocable: true");
    expect(md).toContain('ARGS="$ARGUMENTS"');
    expect(md).toContain('[ -n "$ARGS" ] || ARGS=toggle');
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).toContain("cli/echo");
    expect(md).toContain("not the mute path");
    expect(md).not.toContain("Bun.spawn");
    expect(md).not.toMatch(/POST\s+\/mute/);
    expect(md).not.toMatch(/curl[^\n]*\/mute/);
  });

  test("forwards a non-empty argument and defaults empty input to toggle", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-grok-mute-skill-"));
    try {
      const repo = join(root, "repo");
      const source = join(repo, "adapters/grok/skills/echo-mute/SKILL.md");
      const homeSkill = join(root, "home/.grok/skills/echo-mute");
      const cli = join(repo, "cli/echo");
      const log = join(root, "args.log");
      mkdirSync(join(repo, "adapters/grok/skills/echo-mute"), { recursive: true });
      mkdirSync(join(root, "home/.grok/skills"), { recursive: true });
      mkdirSync(join(repo, "cli"), { recursive: true });
      const md = readFileSync(SKILL, "utf8");
      writeFileSync(source, md);
      symlinkSync(join(repo, "adapters/grok/skills/echo-mute"), homeSkill);
      writeFileSync(cli, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });

      for (const [argument, expected] of [["status", "mute\nstatus\n"], ["", "mute\ntoggle\n"]]) {
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

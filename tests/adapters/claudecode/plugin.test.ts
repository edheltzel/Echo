import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN = "adapters/claudecode/plugin";
const MANIFEST = join(PLUGIN, ".claude-plugin/plugin.json");
const SKILL = join(PLUGIN, "skills/echo-mute/SKILL.md");

function pluginFiles(dir = PLUGIN): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pluginFiles(path));
    else out.push(path);
  }
  return out;
}

function skillBash(): string {
  const md = readFileSync(SKILL, "utf8");
  const block = md.match(/```bash\n([\s\S]*?)\n```/)?.[1];
  if (!block) throw new Error("missing bash block");
  return block;
}

function writeFakeCli(path: string, log: string, marker = false): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const extra = marker ? "Usage: echo <command>\n" : "";
  writeFileSync(path, `#!/bin/bash\n${extra}printf '%s\\n' "$@" > ${JSON.stringify(log)}\n`, { mode: 0o755 });
}

describe("Claude Code mute plugin", () => {
  test("ships plugin.json with name, description, and version", () => {
    expect(existsSync(MANIFEST)).toBe(true);
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;
    expect(manifest.name).toBe("echo");
    expect(typeof manifest.description).toBe("string");
    expect(String(manifest.description).length).toBeGreaterThan(0);
    expect(manifest.version).toBe("0.1.0");
    expect(Object.keys(manifest).sort()).toEqual(["description", "name", "version"]);
  });

  test("plugin.json lives only in .claude-plugin/; skills sit at the plugin root", () => {
    expect(readdirSync(join(PLUGIN, ".claude-plugin"))).toEqual(["plugin.json"]);
    expect(existsSync(SKILL)).toBe(true);
    expect(existsSync(join(PLUGIN, "commands"))).toBe(false);
    expect(existsSync(join(PLUGIN, "hooks"))).toBe(false);
    expect(existsSync(join(PLUGIN, "hooks/hooks.json"))).toBe(false);
    expect(existsSync(join(PLUGIN, ".mcp.json"))).toBe(false);
  });

  test("does not ship daemon install, LaunchAgent payload, or plugin hooks", () => {
    const files = pluginFiles().join("\n");
    expect(files).not.toContain("hooks.json");
    expect(files).not.toContain("install.sh");
    expect(files).not.toContain("com.echo");
    const text = pluginFiles().map((file) => readFileSync(file, "utf8")).join("\n");
    expect(text).not.toMatch(/LaunchAgent/);
    expect(text).not.toMatch(/VoiceGate|VoiceCompletion|VoiceGreeting|SessionStart|restore-hooks/);
    expect(text).not.toContain(".tmp-fm337");
  });

  test("mute skill drives bash cli/echo mute and never Bun or POST /mute", () => {
    const md = readFileSync(SKILL, "utf8");
    expect(md).toContain("name: echo-mute");
    expect(md).toContain("argument-hint: [on|off|toggle|status|duration]");
    expect(md).toContain("every session on this machine");
    expect(md).toContain("/echo-mute");
    expect(md).toContain("/echo:echo-mute");
    expect(md).toContain('ARGS="$ARGUMENTS"');
    expect(md).toContain('[ -n "$ARGS" ] || ARGS=toggle');
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).not.toContain("Bun.spawn");
    expect(md).not.toMatch(/POST\s+\/mute/);
    expect(md).not.toMatch(/curl[^\n]*\/mute/);
    expect(md).not.toContain(".claude/commands");
    expect(md).not.toContain("realpath");
  });

  test("plugin skill is /echo:echo-mute; installer keeps bare /echo-mute", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { name: string };
    expect(manifest.name).toBe("echo");
    expect(existsSync("adapters/claudecode/commands/echo-mute.md")).toBe(true);
    const readme = readFileSync("adapters/claudecode/README.md", "utf8");
    expect(readme).toContain("/echo:echo-mute");
    expect(readme).toContain("Bare `/echo-mute`");
    expect(readme).toContain("always namespaced");
  });

  test("resolves cli/echo from PATH, not a ~/.claude/commands symlink into a tmp worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-plugin-path-"));
    try {
      const home = join(root, "home");
      const commands = join(home, ".claude/commands");
      const tmpWorktree = join(root, ".tmp-fm337-echo");
      const pathRoot = join(root, "on-path");
      const log = join(root, "args.log");
      mkdirSync(commands, { recursive: true });
      mkdirSync(join(tmpWorktree, "adapters/claudecode/commands"), { recursive: true });
      mkdirSync(join(pathRoot, "cli"), { recursive: true });
      writeFakeCli(join(tmpWorktree, "cli/echo"), join(root, "wrong.log"));
      writeFileSync(join(tmpWorktree, "adapters/claudecode/commands/echo-mute.md"), "stale\n");
      symlinkSync(
        join(tmpWorktree, "adapters/claudecode/commands/echo-mute.md"),
        join(commands, "echo-mute.md"),
      );
      writeFakeCli(join(pathRoot, "cli/echo"), log);
      mkdirSync(join(root, "unrelated"), { recursive: true });

      const result = Bun.spawnSync(["/bin/bash", "-c", skillBash().replaceAll("$ARGUMENTS", "status")], {
        cwd: join(root, "unrelated"),
        env: { HOME: home, PATH: `${pathRoot}:/bin:/usr/bin`, GIT_DIR: "/dev/null" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("mute\nstatus\n");
      expect(existsSync(join(root, "wrong.log"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("empty args toggle; git checkout is a known install location", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-plugin-git-"));
    try {
      const repo = join(root, "repo");
      const log = join(root, "args.log");
      mkdirSync(join(repo, "cli"), { recursive: true });
      writeFakeCli(join(repo, "cli/echo"), log);
      const git = Bun.spawnSync(["git", "init"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
      expect(git.exitCode, git.stderr.toString()).toBe(0);

      const result = Bun.spawnSync(["/bin/bash", "-c", skillBash().replaceAll("$ARGUMENTS", "")], {
        cwd: repo,
        env: { HOME: join(root, "home"), PATH: "/bin:/usr/bin" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("mute\ntoggle\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("walks up from CLAUDE_PLUGIN_ROOT to the checkout cli/echo", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-plugin-root-"));
    try {
      const pluginRoot = join(root, "adapters/claudecode/plugin");
      const log = join(root, "args.log");
      mkdirSync(join(root, "cli"), { recursive: true });
      mkdirSync(pluginRoot, { recursive: true });
      mkdirSync(join(root, "elsewhere"), { recursive: true });
      writeFakeCli(join(root, "cli/echo"), log);

      const result = Bun.spawnSync(["/bin/bash", "-c", skillBash().replaceAll("$ARGUMENTS", "off")], {
        cwd: join(root, "elsewhere"),
        env: {
          HOME: join(root, "home"),
          PATH: "/bin:/usr/bin",
          GIT_DIR: "/dev/null",
          CLAUDE_PLUGIN_ROOT: pluginRoot,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(log, "utf8")).toBe("mute\noff\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to follow a ~/.claude/commands symlink when PATH and checkout are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "echo-claude-plugin-refuse-"));
    try {
      const home = join(root, "home");
      const commands = join(home, ".claude/commands");
      const tmpWorktree = join(root, ".tmp-fm337-echo");
      mkdirSync(commands, { recursive: true });
      mkdirSync(join(tmpWorktree, "adapters/claudecode/commands"), { recursive: true });
      writeFakeCli(join(tmpWorktree, "cli/echo"), join(root, "wrong.log"));
      writeFileSync(join(tmpWorktree, "adapters/claudecode/commands/echo-mute.md"), "stale\n");
      symlinkSync(
        join(tmpWorktree, "adapters/claudecode/commands/echo-mute.md"),
        join(commands, "echo-mute.md"),
      );
      mkdirSync(join(root, "unrelated"), { recursive: true });

      const result = Bun.spawnSync(["/bin/bash", "-c", skillBash().replaceAll("$ARGUMENTS", "on")], {
        cwd: join(root, "unrelated"),
        env: { HOME: home, PATH: "/bin:/usr/bin", GIT_DIR: "/dev/null" },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("cli/echo not found");
      expect(existsSync(join(root, "wrong.log"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("claude plugin validate, or the in-repo equivalent when claude is absent", () => {
    const claude = Bun.which("claude");
    if (claude) {
      const result = Bun.spawnSync([claude, "plugin", "validate", resolve(PLUGIN), "--strict"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0);
      return;
    }

    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      name: string;
      description: string;
      version: string;
    };
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)).toBe(true);
    expect(/^\d+\.\d+\.\d+$/.test(manifest.version)).toBe(true);
    const md = readFileSync(SKILL, "utf8");
    expect(md.startsWith("---\n")).toBe(true);
    expect(md).toContain("name: echo-mute");
    expect(existsSync(join(PLUGIN, "hooks/hooks.json"))).toBe(false);
  });
});

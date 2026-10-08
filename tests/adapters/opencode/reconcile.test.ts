import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RECONCILE = resolve("adapters/opencode/reconcile.ts");
const MUTE_SOURCE = resolve("adapters/opencode/commands/echo-mute.md");
const PLUGIN_SOURCE = resolve("adapters/opencode/plugin.ts");

// Both OpenCode dirs live under `root`, never the operator's ~/.config/opencode.
function runReconcile(root: string, check = false) {
  const result = Bun.spawnSync([process.execPath, RECONCILE, ...(check ? ["--check"] : [])], {
    env: {
      ...process.env,
      ECHO_OPENCODE_COMMANDS_DIR: join(root, "commands"),
      ECHO_OPENCODE_PLUGINS_DIR: join(root, "plugins"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function withRoot(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "echo-opencode-reconcile-"));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("OpenCode registration", () => {
  test("command file drives bash cli/echo mute and never Bun or POST /mute", () => {
    expect(existsSync(MUTE_SOURCE)).toBe(true);
    const md = readFileSync(MUTE_SOURCE, "utf8");
    expect(md).toContain('bash "$CLI" mute "$ARGS"');
    expect(md).not.toContain("Bun.spawn");
    expect(md).not.toMatch(/POST\s+\/mute/);
  });

  test("reconcile creates the plugin and mute links, then reports current", () => {
    withRoot((root) => {
      expect(runReconcile(root, true).exitCode).toBe(3);
      expect(existsSync(join(root, "plugins"))).toBe(false);
      expect(runReconcile(root).exitCode).toBe(0);
      expect(readlinkSync(join(root, "plugins", "echo-voice.ts"))).toBe(realpathSync(PLUGIN_SOURCE));
      expect(readlinkSync(join(root, "commands", "echo-mute.md"))).toBe(realpathSync(MUTE_SOURCE));
      expect(runReconcile(root, true).exitCode).toBe(0);
    });
  });

  test("heals a dead Echo plugin link from a moved checkout", () => {
    withRoot((root) => {
      mkdirSync(join(root, "plugins"), { recursive: true });
      symlinkSync("/gone/Echo/adapters/opencode/plugin.ts", join(root, "plugins", "echo-voice.ts"));
      expect(runReconcile(root, true).exitCode).toBe(3);
      expect(runReconcile(root).exitCode).toBe(0);
      expect(readlinkSync(join(root, "plugins", "echo-voice.ts"))).toBe(realpathSync(PLUGIN_SOURCE));
    });
  });

  test("refuses foreign occupants without mutating them", () => {
    for (const [dir, name] of [["commands", "echo-mute.md"], ["plugins", "echo-voice.ts"]]) {
      withRoot((root) => {
        mkdirSync(join(root, dir), { recursive: true });
        const foreign = join(root, dir, name);
        writeFileSync(foreign, "third-party\n");
        expect(runReconcile(root).exitCode).toBe(2);
        expect(lstatSync(foreign).isSymbolicLink()).toBe(false);
        expect(readFileSync(foreign, "utf8")).toBe("third-party\n");
      });
    }
  });
});

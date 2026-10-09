import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const RECONCILE = resolve("adapters/opencode/reconcile.ts");
const MUTE_SOURCE = resolve("adapters/opencode/commands/echo-mute.md");
const PLUGIN_SOURCE = resolve("adapters/opencode/plugin.ts");

// Every OpenCode path lives under `root`, never the operator's ~/.config/opencode.
function runReconcile(root: string, check = false, overrides: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, RECONCILE, ...(check ? ["--check"] : [])], {
    env: {
      ...process.env,
      ECHO_OPENCODE_COMMANDS_DIR: join(root, "commands"),
      ECHO_OPENCODE_PLUGINS_DIR: join(root, "plugins"),
      ECHO_OPENCODE_CONFIG: join(root, "opencode.json"),
      ...overrides,
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

  test("prunes Echo plugin entries from a symlinked JSON config, keeping everything else", () => {
    withRoot((root) => {
      const dotfiles = join(root, "dotfiles");
      mkdirSync(dotfiles);
      const real = join(dotfiles, "opencode.json");
      writeFileSync(real, JSON.stringify({
        daidentity: { name: "Neo" },
        plugin: ["file:///old/clone/Echo/adapters/opencode/plugin.ts", "opencode-wakatime"],
      }));
      symlinkSync(real, join(root, "opencode.json"));

      const check = runReconcile(root, true);
      expect(check.exitCode).toBe(3);
      expect(JSON.parse(readFileSync(real, "utf8")).plugin).toHaveLength(2);

      expect(runReconcile(root).exitCode).toBe(0);
      expect(lstatSync(join(root, "opencode.json")).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({
        daidentity: { name: "Neo" },
        plugin: ["opencode-wakatime"],
      });
      expect(readdirSync(dotfiles).some((name) => name.startsWith("opencode.json.bak-"))).toBe(true);

      const before = readFileSync(real, "utf8");
      expect(runReconcile(root, true).exitCode).toBe(0);
      expect(runReconcile(root).exitCode).toBe(0);
      expect(readFileSync(real, "utf8")).toBe(before);
    });
  });

  test("refuses to rewrite a JSONC config that lists Echo, leaving it untouched", () => {
    withRoot((root) => {
      const text = '{\n  // my plugins\n  "plugin": ["/Echo/adapters/opencode/plugin.ts"],\n}\n';
      writeFileSync(join(root, "opencode.json"), text);
      const result = runReconcile(root);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Remove that \"plugin\" entry by hand");
      expect(readFileSync(join(root, "opencode.json"), "utf8")).toBe(text);
      expect(existsSync(join(root, "plugins"))).toBe(false);
    });
  });

  test("a failed config prune creates no plugin symlink beside the old entry", () => {
    withRoot((root) => {
      const locked = join(root, "locked");
      mkdirSync(locked);
      const real = join(locked, "opencode.json");
      writeFileSync(real, JSON.stringify({ plugin: ["/Echo/adapters/opencode/plugin.ts"] }));
      symlinkSync(real, join(root, "opencode.json"));
      chmodSync(locked, 0o555); // backup and temp file cannot be written
      try {
        expect(runReconcile(root).exitCode).not.toBe(0);
        expect(existsSync(join(root, "plugins", "echo-voice.ts"))).toBe(false);
        expect(JSON.parse(readFileSync(real, "utf8")).plugin).toHaveLength(1);
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  });

  test("an empty or unparseable config never blocks registration", () => {
    for (const text of ["", "  \n", "{ not json"]) {
      withRoot((root) => {
        writeFileSync(join(root, "opencode.json"), text);
        expect(runReconcile(root, true).exitCode).toBe(3);
        expect(runReconcile(root).exitCode).toBe(0);
        expect(existsSync(join(root, "plugins", "echo-voice.ts"))).toBe(true);
        expect(readFileSync(join(root, "opencode.json"), "utf8")).toBe(text);
      });
    }
  });

  test("prunes the tuple form [spec, options] too", () => {
    withRoot((root) => {
      writeFileSync(join(root, "opencode.json"), JSON.stringify({
        plugin: [["file:///old/Echo/adapters/opencode/plugin.ts", { verbose: true }], ["opencode-wakatime", {}]],
      }));
      expect(runReconcile(root).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")).plugin).toEqual([["opencode-wakatime", {}]]);
    });
  });

  test("prunes the global file OpenCode takes its plugin list from, not a shadowed one", () => {
    const echo = "file:///old/Echo/adapters/opencode/plugin.ts";
    // Unpinned discovery: every global file lives under a scratch XDG_CONFIG_HOME.
    const unpinned = (root: string) => ({ ECHO_OPENCODE_CONFIG: "", XDG_CONFIG_HOME: join(root, "xdg"), HOME: root });
    withRoot((root) => {
      const dir = join(root, "xdg", "opencode");
      mkdirSync(dir, { recursive: true });
      // opencode.jsonc has no `plugin` key, so opencode.json's list is the one OpenCode loads.
      writeFileSync(join(dir, "opencode.jsonc"), '{\n  // theme only\n  "theme": "tokyonight"\n}\n');
      writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: [echo, "opencode-wakatime"] }));
      const check = runReconcile(root, true, unpinned(root));
      expect(check.stdout).toContain(`"plugin" -= ${echo}`);
      expect(runReconcile(root, false, unpinned(root)).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).plugin).toEqual(["opencode-wakatime"]);
      expect(readFileSync(join(dir, "opencode.jsonc"), "utf8")).toContain("// theme only");
    });
    withRoot((root) => {
      const dir = join(root, "xdg", "opencode");
      mkdirSync(dir, { recursive: true });
      // opencode.jsonc defines `plugin`, so the entry in opencode.json never loads: leave it.
      writeFileSync(join(dir, "opencode.jsonc"), JSON.stringify({ plugin: ["opencode-wakatime"] }));
      writeFileSync(join(dir, "opencode.json"), JSON.stringify({ plugin: [echo] }));
      expect(runReconcile(root, false, unpinned(root)).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8")).plugin).toEqual([echo]);
    });
  });
});

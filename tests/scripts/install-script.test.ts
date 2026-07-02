import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runInstall(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", "scripts/install.sh", ...args], {
    env: { ...env, PATH: env.PATH },
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

describe("install script adapter support", () => {
  const script = readFileSync("scripts/install.sh", "utf8");

  test("supports core, Claude Code, Pi, and omp adapter modes", () => {
    expect(script).toContain("--adapter none|claudecode|pi|omp");
    expect(script).toContain("adapters/claudecode/restore-hooks.ts\" --check");
    expect(script).toContain("pi install");
    expect(script).toContain("adapters/pi/reconcile-omp.ts");
  });

  test("uses the com.echo service name and migrates both legacy labels", () => {
    expect(script).toContain('SERVICE_NAME="com.echo"');
    // Both former labels are quarantined on install: the PAI-named service and
    // the prior "Atlas" name.
    expect(script).toContain("com.pai.voice-server");
    expect(script).toContain("com.atlas.voicesystem");
    expect(script).toContain("Quarantining legacy LaunchAgent plist");
  });

  test("preflights missing Pi before mutating host state", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-install-preflight-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      const launchctlLog = join(root, "launchctl.log");

      writeExecutable(join(bin, "bun"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "launchctl"), `#!/bin/bash\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`);

      const result = await runInstall(["--adapter", "pi"], {
        HOME: home,
        PATH: `${bin}:/bin:/usr/bin:/usr/sbin:/sbin`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Pi CLI is required");
      expect(existsSync(join(home, "Library/LaunchAgents/com.echo.plist"))).toBe(false);
      expect(existsSync(launchctlLog)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preflights missing omp before mutating host state", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlas-install-preflight-omp-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      const launchctlLog = join(root, "launchctl.log");

      writeExecutable(join(bin, "bun"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "launchctl"), `#!/bin/bash\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`);

      const result = await runInstall(["--adapter", "omp"], {
        HOME: home,
        PATH: `${bin}:/bin:/usr/bin:/usr/sbin:/sbin`,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("omp CLI is required");
      expect(existsSync(join(home, "Library/LaunchAgents/com.echo.plist"))).toBe(false);
      expect(existsSync(launchctlLog)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("unloads and quarantines BOTH legacy LaunchAgents before loading com.echo", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-migration-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const state = join(root, "state");
      const launchAgents = join(home, "Library/LaunchAgents");
      const launchctlLog = join(root, "launchctl.log");
      mkdirSync(bin, { recursive: true });
      mkdirSync(state, { recursive: true });
      mkdirSync(launchAgents, { recursive: true });
      // Both former labels exist on disk; the prior "Atlas" service is the one
      // actually loaded — the realistic reinstall-from-com.atlas.voicesystem case.
      writeFileSync(join(launchAgents, "com.pai.voice-server.plist"), "legacy-pai");
      writeFileSync(join(launchAgents, "com.atlas.voicesystem.plist"), "legacy-atlas");
      writeFileSync(join(state, "atlas-legacy-loaded"), "1");

      writeExecutable(join(bin, "bun"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "launchctl"), `#!/bin/bash
set -e
echo "$@" >> ${JSON.stringify(launchctlLog)}
case "$1" in
  list)
    [ -f ${JSON.stringify(join(state, "echo-loaded"))} ] && echo "111 0 com.echo"
    [ -f ${JSON.stringify(join(state, "pai-legacy-loaded"))} ] && echo "222 0 com.pai.voice-server"
    [ -f ${JSON.stringify(join(state, "atlas-legacy-loaded"))} ] && echo "333 0 com.atlas.voicesystem"
    ;;
  unload)
    case "$2" in
      *com.pai.voice-server.plist) rm -f ${JSON.stringify(join(state, "pai-legacy-loaded"))} ;;
      *com.atlas.voicesystem.plist) rm -f ${JSON.stringify(join(state, "atlas-legacy-loaded"))} ;;
      *com.echo.plist) rm -f ${JSON.stringify(join(state, "echo-loaded"))} ;;
    esac
    ;;
  load)
    touch ${JSON.stringify(join(state, "echo-loaded"))}
    ;;
esac
exit 0
`);

      const result = await runInstall(["--adapter", "none"], {
        HOME: home,
        PATH: `${bin}:/bin:/usr/bin:/usr/sbin:/sbin`,
      });

      expect(result.exitCode).toBe(0);
      // Both legacy plists are quarantined (renamed with a .migrated-<stamp> suffix).
      expect(existsSync(join(launchAgents, "com.pai.voice-server.plist"))).toBe(false);
      expect(readdirSync(launchAgents).some((name) => name.startsWith("com.pai.voice-server.plist.migrated-"))).toBe(true);
      expect(existsSync(join(launchAgents, "com.atlas.voicesystem.plist"))).toBe(false);
      expect(readdirSync(launchAgents).some((name) => name.startsWith("com.atlas.voicesystem.plist.migrated-"))).toBe(true);
      // The new neutral service plist is written and loaded.
      expect(existsSync(join(launchAgents, "com.echo.plist"))).toBe(true);

      const log = readFileSync(launchctlLog, "utf8");
      // The loaded legacy (com.atlas.voicesystem) is unloaded before com.echo loads.
      expect(log.indexOf("unload")).toBeGreaterThan(-1);
      expect(log.indexOf("load")).toBeGreaterThan(log.indexOf("unload"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

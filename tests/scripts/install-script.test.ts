import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
    // omp preflight runs --check (tolerating exit 3 = pending) so a FATAL
    // registration state aborts before any host state is mutated.
    expect(script).toContain('reconcile-omp.ts" --check >/dev/null || [ $? -eq 3 ]');
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

  // Reviewer scenario (PR #80 finding 2): a FATAL omp registration state must
  // abort in preflight, BEFORE the LaunchAgent plist is written or launchctl runs.
  test("omp preflight surfaces a FATAL registration state before mutating host state", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-omp-fatal-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const extensions = join(root, "extensions");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      // FATAL state: a real directory occupies the echo-voice name.
      mkdirSync(join(extensions, "echo-voice"), { recursive: true });
      const launchctlLog = join(root, "launchctl.log");

      // Real bun (the preflight actually runs reconcile-omp.ts); stub the rest.
      writeExecutable(join(bin, "bun"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      writeExecutable(join(bin, "omp"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "launchctl"), `#!/bin/bash\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`);

      const result = await runInstall(["--adapter", "omp"], {
        HOME: home,
        PATH: `${bin}:/bin:/usr/bin:/usr/sbin:/sbin`,
        OMP_EXTENSIONS_DIR: extensions,
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("FATAL");
      expect(existsSync(join(home, "Library/LaunchAgents/com.echo.plist"))).toBe(false);
      expect(existsSync(launchctlLog)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("omp preflight tolerates pending changes (exit 3) and the install registers the adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-omp-ok-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const state = join(root, "state");
      const extensions = join(root, "extensions"); // absent → --check exits 3 (pending)
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(state, { recursive: true });

      writeExecutable(join(bin, "bun"), `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
      writeExecutable(join(bin, "omp"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "launchctl"), `#!/bin/bash
case "$1" in
  list) [ -f ${JSON.stringify(join(state, "echo-loaded"))} ] && echo "111 0 com.echo" ;;
  load) touch ${JSON.stringify(join(state, "echo-loaded"))} ;;
esac
exit 0
`);

      const result = await runInstall(["--adapter", "omp"], {
        HOME: home,
        PATH: `${bin}:/bin:/usr/bin:/usr/sbin:/sbin`,
        OMP_EXTENSIONS_DIR: extensions,
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(home, "Library/LaunchAgents/com.echo.plist"))).toBe(true);
      // install_adapter reconciled the registration.
      expect(lstatSync(join(extensions, "echo-voice")).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refreshes ALL installed adapters regardless of --adapter, and rerunning is a no-op (#77)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-refresh-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".pi/agent"), { recursive: true });
      mkdirSync(bin, { recursive: true });

      // Registrations left behind by a renamed repo directory: markers present, paths dead.
      const claudeSettings = join(home, ".claude/settings.json");
      const piSettings = join(home, ".pi/agent/settings.json");
      writeFileSync(
        claudeSettings,
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "/old/clone/adapters/claudecode/hooks/VoiceGate.hook.ts" }],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n",
      );
      writeFileSync(piSettings, JSON.stringify({ packages: ["/old/clone/adapters/pi"] }, null, 2) + "\n");

      // Real bun (the adapter tools must actually run); stub the service plumbing —
      // `list` must report com.echo so the post-load liveness check passes.
      writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; esac\nexit 0\n');
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
      const bunDir = join(Bun.which("bun")!, "..");
      const env = { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin` };

      // --adapter none: neither adapter was asked for, both must still be reconciled.
      const first = await runInstall(["--adapter", "none"], env);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("Refreshing Claude Code adapter hook registrations");
      expect(first.stdout).toContain("Refreshing Pi adapter registration");

      const claudeAfterFirst = readFileSync(claudeSettings, "utf8");
      const piAfterFirst = readFileSync(piSettings, "utf8");
      expect(claudeAfterFirst).not.toContain("/old/clone/");
      expect(piAfterFirst).not.toContain("/old/clone/");
      expect(claudeAfterFirst).toContain("adapters/claudecode/hooks/VoiceGate.hook.ts");
      expect(piAfterFirst).toContain("adapters/pi");

      // Rerunning is a no-op: settings bytes unchanged.
      const second = await runInstall(["--adapter", "none"], env);
      expect(second.exitCode).toBe(0);
      expect(readFileSync(claudeSettings, "utf8")).toBe(claudeAfterFirst);
      expect(readFileSync(piSettings, "utf8")).toBe(piAfterFirst);

      // After healing, --check reports clean with exit 0.
      const check = await runInstall(["--check"], env);
      expect(check.exitCode).toBe(0);
      expect(check.stderr).not.toContain("Stale paths found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Reviewer finding 3 on PR #80: omp must inherit #77's every-run heal and
  // --check aggregation, detected only when actually registered (echo-voice link).
  test("refresh-all heals a stale omp registration and --check aggregates it (#18)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-omp-refresh-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const extensions = join(root, "extensions");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(extensions, { recursive: true });
      // Registration left behind by a renamed repo directory: echo-voice present, target dead.
      symlinkSync("/old/clone/adapters/pi", join(extensions, "echo-voice"));

      writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; esac\nexit 0\n');
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
      const bunDir = join(Bun.which("bun")!, "..");
      const env = {
        HOME: home,
        PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin`,
        OMP_EXTENSIONS_DIR: extensions,
      };

      // Aggregated --check sees the stale omp state: exit 3.
      const staleCheck = await runInstall(["--check"], env);
      expect(staleCheck.exitCode).toBe(3);
      expect(staleCheck.stdout).toContain("Checking oh-my-pi adapter registration");
      expect(staleCheck.stderr).toContain("Stale paths found");

      // One install run (omp not even requested) heals via refresh-all.
      const first = await runInstall(["--adapter", "none"], env);
      expect(first.exitCode).toBe(0);
      expect(first.stdout).toContain("Refreshing oh-my-pi adapter registration");
      expect(readlinkSync(join(extensions, "echo-voice"))).toBe(realpathSync(resolve("adapters/pi")));

      // After healing, --check reports clean with exit 0.
      const check = await runInstall(["--check"], env);
      expect(check.exitCode).toBe(0);
      expect(check.stderr).not.toContain("Stale paths found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refresh-all never touches host configs that merely contain lookalike substrings", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-lookalike-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".pi/agent"), { recursive: true });
      mkdirSync(bin, { recursive: true });

      // Substring lookalikes that the reconcilers would NOT match: detection must not
      // trip on them, or refresh would append an echo registration to a host that
      // never had one.
      const claudeSettings = join(home, ".claude/settings.json");
      const piSettings = join(home, ".pi/agent/settings.json");
      const claudeOriginal =
        JSON.stringify(
          { permissions: { allow: ["Bash(ls /y/adapters/claudecode/hooks/)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [] }] } },
          null,
          2,
        ) + "\n";
      const piOriginal =
        JSON.stringify(
          { packages: ["/x/adapters/pipeline-tools", "git:github.com/user/adapters/pi"] },
          null,
          2,
        ) + "\n";
      writeFileSync(claudeSettings, claudeOriginal);
      writeFileSync(piSettings, piOriginal);

      writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; esac\nexit 0\n');
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
      const bunDir = join(Bun.which("bun")!, "..");
      const result = await runInstall(["--adapter", "none"], {
        HOME: home,
        PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("Refreshing");
      expect(readFileSync(claudeSettings, "utf8")).toBe(claudeOriginal);
      expect(readFileSync(piSettings, "utf8")).toBe(piOriginal);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a broken secondary adapter config warns but does not abort the requested install", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-warn-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(bin, { recursive: true });

      // A genuine echo hook registration (detection trips) but no PreToolUse Bash
      // matcher — restore-hooks exits 2 (FATAL). The refresh must warn and continue.
      const claudeSettings = join(home, ".claude/settings.json");
      writeFileSync(
        claudeSettings,
        JSON.stringify(
          { hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/clone/adapters/claudecode/hooks/VoiceCompletion.hook.ts" }] }] } },
          null,
          2,
        ) + "\n",
      );

      writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; esac\nexit 0\n');
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 0\n");
      const bunDir = join(Bun.which("bun")!, "..");
      const result = await runInstall(["--adapter", "none"], {
        HOME: home,
        PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin`,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("WARN: Claude Code hook refresh failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("--check reports dead echo-related paths across plist and host settings without mutating (#77)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-install-check-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const launchAgents = join(home, "Library/LaunchAgents");
      const launchctlLog = join(root, "launchctl.log");
      mkdirSync(launchAgents, { recursive: true });
      mkdirSync(join(home, ".claude"), { recursive: true });
      mkdirSync(join(home, ".pi/agent"), { recursive: true });
      mkdirSync(bin, { recursive: true });

      const plistPath = join(launchAgents, "com.echo.plist");
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>run</string>
        <string>/dead/repo/core/server.ts</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/dead/repo</string>
</dict>
</plist>
`;
      writeFileSync(plistPath, plist);
      const claudeSettings = join(home, ".claude/settings.json");
      const piSettings = join(home, ".pi/agent/settings.json");
      const claudeOriginal =
        JSON.stringify(
          {
            hooks: {
              PreToolUse: [
                {
                  matcher: "Bash",
                  hooks: [{ type: "command", command: "/old/clone/adapters/claudecode/hooks/VoiceGate.hook.ts" }],
                },
              ],
            },
          },
          null,
          2,
        ) + "\n";
      const piOriginal = JSON.stringify({ packages: ["/old/clone/adapters/pi"] }, null, 2) + "\n";
      writeFileSync(claudeSettings, claudeOriginal);
      writeFileSync(piSettings, piOriginal);

      writeExecutable(join(bin, "launchctl"), `#!/bin/bash\necho "$@" >> ${JSON.stringify(launchctlLog)}\nexit 0\n`);
      const bunDir = join(Bun.which("bun")!, "..");
      const result = await runInstall(["--check"], {
        HOME: home,
        PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin`,
      });

      // Exit 3 = staleness detected, machine-checkable; the summary fires.
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("Stale paths found");
      // Dead repo paths in the plist are reported.
      expect(result.stdout).toContain("/dead/repo/core/server.ts");
      expect(result.stdout).toContain("/dead/repo");
      // BOTH host settings checks ran (a stale first check must not truncate the scan).
      expect(result.stdout).toContain("Checking Claude Code adapter hook registrations");
      expect(result.stdout).toContain("Checking Pi adapter registration");
      expect(result.stdout).toContain("would be updated");
      // Nothing was mutated and no service was touched.
      expect(readFileSync(plistPath, "utf8")).toBe(plist);
      expect(readFileSync(claudeSettings, "utf8")).toBe(claudeOriginal);
      expect(readFileSync(piSettings, "utf8")).toBe(piOriginal);
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

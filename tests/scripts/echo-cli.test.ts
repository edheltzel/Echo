import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The `echo` CLI is a thin bash wrapper over scripts/*.sh + the daemon API.
// Every test runs in a temp HOME with stubbed launchctl/curl — it never touches
// the operator's real daemon. `doctor` and `status` are read-only by design.

const CLI = "cli/echo";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runCli(args: string[], env: Record<string, string>) {
  // `install` and `doctor` both reach scripts/install.sh; opting every run out of
  // workspace-link management keeps `bun test` off the checkout's node_modules.
  const proc = Bun.spawn(["/bin/bash", CLI, ...args], {
    env: { ECHO_SKIP_WORKSPACE_LINK: "1", ...env },
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

const bunDir = join(Bun.which("bun")!, "..");
// Driving install.sh costs a 2s launchd settle per run — more than bun's 5s
// default allows once a test also runs doctor (which shells out to install --check).
const INSTALL_TIMEOUT_MS = 30_000;

describe("echo CLI dispatch", () => {
  test("no args prints usage listing every subcommand", async () => {
    const r = await runCli([], { HOME: "/tmp", PATH: `${bunDir}:/bin:/usr/bin` });
    expect(r.exitCode).toBe(0);
    for (const cmd of ["install", "doctor", "status", "mute", "voice", "update", "uninstall"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  test("unknown command exits 2", async () => {
    const r = await runCli(["frobnicate"], { HOME: "/tmp", PATH: `${bunDir}:/bin:/usr/bin` });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });
});

describe("echo doctor", () => {
  test("a bare system reports degraded states with recovery commands", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-doctor-bare-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      // launchctl present but nothing loaded; curl present but nothing answers.
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 7\n");

      const r = await runCli(["doctor"], { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` });

      // Degraded overall; each ✗ row must carry a concrete recovery command.
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("Result: DEGRADED");
      expect(r.stdout).toContain("payload");
      expect(r.stdout).toContain("echo install");
      // The Bun prerequisite is diagnosed (doctor itself runs without needing it).
      expect(r.stdout).toContain("bun");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags an enabled-but-unhealthy provider whatever order /health serialized the keys in", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-doctor-providers-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      // `healthy` BEFORE `enabled`, with another key wedged between them, and a
      // healthy provider ahead of it — the row must not depend on field order.
      const body =
        '{"status":"healthy","providers":' +
        '{"edgetts":{"enabled":true,"healthy":true,"wouldEgress":true},' +
        '"kokoro":{"healthy":false,"wouldEgress":false,"enabled":true}}}';
      writeExecutable(join(bin, "curl"), `#!/bin/bash\necho ${JSON.stringify(body)}\nexit 0\n`);

      const r = await runCli(["doctor"], { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` });
      expect(r.stdout).toContain("a configured TTS provider is unhealthy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an all-healthy /health leaves the providers row ok", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-doctor-providers-ok-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(home, { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      // A DISABLED provider reports healthy:false; pairing it with a different
      // provider's enabled:true must not be read as one unhealthy provider.
      const body =
        '{"status":"healthy","providers":' +
        '{"edgetts":{"enabled":true,"healthy":true,"wouldEgress":true},' +
        '"elevenlabs":{"enabled":false,"healthy":false,"wouldEgress":false}}}';
      writeExecutable(join(bin, "curl"), `#!/bin/bash\necho ${JSON.stringify(body)}\nexit 0\n`);

      const r = await runCli(["doctor"], { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` });
      expect(r.stdout).toContain("configured TTS providers healthy");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")(
    "reports READY once the payload is staged and the daemon answers /health",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "echo-doctor-ready-"));
      try {
        const home = join(root, "home");
        const bin = join(root, "bin");
        mkdirSync(home, { recursive: true });
        mkdirSync(bin, { recursive: true });
        // Stub launchctl (com.echo loaded) + curl (healthy /health JSON).
        writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; esac\nexit 0\n');
        writeExecutable(join(bin, "curl"), '#!/bin/bash\necho \'{"status":"healthy","providers":{"edgetts":{"enabled":true,"healthy":true}}}\'\nexit 0\n');
        const env = { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin` };

        // Stage the payload first (install.sh runs in the same temp HOME).
        const install = await runCli(["install", "--adapter", "none"], env);
        expect(install.exitCode).toBe(0);

        const r = await runCli(["doctor"], env);
        expect(r.stdout).toContain("Result: READY");
        expect(r.exitCode).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    INSTALL_TIMEOUT_MS,
  );
});

describe("echo mute", () => {
  function muteEnv(root: string): { env: Record<string, string>; log: string } {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "curl-args.log");
    // Stub curl: record argv, answer with an empty JSON body.
    writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\necho '{}'\nexit 0\n`);
    return { env: { HOME: join(root, "home"), PATH: `${bin}:${bunDir}:/bin:/usr/bin` }, log };
  }

  test("translates a minute/hour duration into mute.sh on <minutes>", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mute-"));
    try {
      const { env, log } = muteEnv(root);
      expect((await runCli(["mute", "30m"], env)).exitCode).toBe(0);
      expect((await runCli(["mute", "1h"], env)).exitCode).toBe(0);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain('"duration_minutes": 30');
      expect(logged).toContain('"duration_minutes": 60');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a bad duration and requires an argument", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mute-bad-"));
    try {
      const { env } = muteEnv(root);
      expect((await runCli(["mute", "banana"], env)).exitCode).toBe(2);
      expect((await runCli(["mute"], env)).exitCode).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("echo uninstall", () => {
  test("removes only the payload, preserving mute state, logs, and persona config", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-uninstall-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      // PORT points at an unused port so uninstall.sh's lsof note stays quiet.
      const env = { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin`, PORT: "8991" };

      // The payload lives in its own subdir under the case-insensitive `echo`
      // state dir; mute.json is a SIBLING that must survive uninstall.
      const stateDir = join(home, "Library/Application Support/echo");
      const payload = join(stateDir, "payload");
      const muteState = join(stateDir, "mute.json");
      const plist = join(home, "Library/LaunchAgents/com.echo.plist");
      const log = join(home, "Library/Logs/echo.log");
      const envFile = join(home, ".config/echo/.env");
      for (const f of [join(payload, "versions/0.0.0/core/server.ts"), muteState, plist, log, envFile]) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, "x");
      }

      // --check mutates nothing.
      const check = await runCli(["uninstall", "--check"], env);
      expect(check.exitCode).toBe(0);
      expect(existsSync(payload)).toBe(true);
      expect(existsSync(plist)).toBe(true);

      const r = await runCli(["uninstall"], env);
      expect(r.exitCode).toBe(0);
      // Payload + LaunchAgent removed…
      expect(existsSync(payload)).toBe(false);
      expect(existsSync(plist)).toBe(false);
      // …but sibling daemon state, logs, and persona config are preserved.
      expect(existsSync(muteState)).toBe(true);
      expect(existsSync(log)).toBe(true);
      expect(existsSync(envFile)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("exits 0 when there is no persona config to preserve", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-uninstall-noenv-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(bin, { recursive: true });
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      const env = { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin`, PORT: "8991" };
      mkdirSync(join(home, "Library/Application Support/echo/payload"), { recursive: true });

      // Every user who never ran `echo voice` lands here; a clean uninstall is exit 0.
      expect((await runCli(["uninstall", "--check"], env)).exitCode).toBe(0);
      expect((await runCli(["uninstall"], env)).exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("echo voice", () => {
  test("merge-writes the default persona env, preserving unrelated keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-"));
    try {
      const envFile = join(root, "echo.env");
      writeFileSync(envFile, "# my config\nUNRELATED=keepme\nECHO_VOICE_ID=old-value\n");
      const env = {
        HOME: join(root, "home"),
        PATH: `${bunDir}:/bin:/usr/bin`,
        ECHO_ENV_FILE: envFile,
      };

      const r = await runCli(["voice", "Echo", "en-US-AndrewNeural"], env);
      expect(r.exitCode).toBe(0);

      const written = readFileSync(envFile, "utf8");
      expect(written).toContain('ECHO_VOICE_PERSONA_NAME="Echo"');
      expect(written).toContain('ECHO_VOICE_ID="en-US-AndrewNeural"');
      // The prior ECHO_VOICE_ID assignment is replaced, not duplicated.
      expect(written).not.toContain("old-value");
      // Unrelated keys and comments survive the merge.
      expect(written).toContain("UNRELATED=keepme");
      expect(written).toContain("# my config");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a persona name that would inject extra env lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-inject-"));
    try {
      const envFile = join(root, "echo.env");
      writeFileSync(envFile, "UNRELATED=keepme\n");
      const env = {
        HOME: join(root, "home"),
        PATH: `${bunDir}:/bin:/usr/bin`,
        ECHO_ENV_FILE: envFile,
      };

      const r = await runCli(["voice", 'Echo"\nELEVENLABS_API_KEY=stolen', "en-US-AndrewNeural"], env);
      expect(r.exitCode).toBe(2);
      // The env file the daemon parses is left untouched.
      expect(readFileSync(envFile, "utf8")).toBe("UNRELATED=keepme\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a non-edge-tts voice id", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-bad-"));
    try {
      const env = {
        HOME: join(root, "home"),
        PATH: `${bunDir}:/bin:/usr/bin`,
        ECHO_ENV_FILE: join(root, "echo.env"),
      };
      const r = await runCli(["voice", "Echo", "not-a-voice"], env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("edge-tts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

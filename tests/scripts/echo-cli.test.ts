import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The `echo` CLI is a thin bash wrapper over scripts/*.sh + the daemon API.
// Every test runs in a temp HOME with stubbed launchctl/curl — it never touches
// the operator's real daemon. `doctor` and `status` are read-only by design.

const CLI = "cli/echo";

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["/bin/bash", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const bunDir = join(Bun.which("bun")!, "..");

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

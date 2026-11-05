import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// The `echo` CLI is a thin bash wrapper over scripts/*.sh + the daemon API.
// Every test runs in a temp HOME with stubbed launchctl/curl - it never touches
// the operator's real daemon. `doctor` and `status` are read-only by design.

const CLI = join(import.meta.dir, "../../cli/echo");

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o755 });
}

async function runCli(args: string[], env: Record<string, string>, cwd?: string) {
  // `install` and `doctor` both reach scripts/install.sh; opting every run out of
  // workspace-link management keeps `bun test` off the checkout's node_modules.
  const proc = Bun.spawn(["/bin/bash", CLI, ...args], {
    cwd,
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
// Driving install.sh costs a 2s launchd settle per run - more than bun's 5s
// default allows once a test also runs doctor (which shells out to install --check).
const INSTALL_TIMEOUT_MS = 30_000;

describe("echo CLI dispatch", () => {
  test("no args prints usage listing every subcommand", async () => {
    const r = await runCli([], { HOME: "/tmp", PATH: `${bunDir}:/bin:/usr/bin` });
    expect(r.exitCode).toBe(0);
    for (const cmd of ["install", "doctor", "status", "mute", "mode", "replay", "voice", "update", "uninstall"]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  test("unknown command exits 2", async () => {
    const r = await runCli(["frobnicate"], { HOME: "/tmp", PATH: `${bunDir}:/bin:/usr/bin` });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  test("uses the configured JSON port when PORT is not exported", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-cli-config-port-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(home, ".config", "echo", "config.json"), JSON.stringify({ PORT: 3457 }));
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s' '{"status":"healthy","activeProvider":"edgetts","mode":"speech","mute":{"muted":false,"scope":"all"},"play_queue":{"depth":0},"capture_guard":{"state":"idle"},"replay":{"available":0,"capacity":10},"providers":{},"config":{"valid":true,"ignored_keys":[],"retired_keys":[]}}'\nexit 0\n`);

      const r = await runCli(["status"], { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("running on :3457");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The daemon drops a PORT it would resolve differently, so every such value
  // must send the CLI to 3246 too - otherwise the shell surfaces probe a port the
  // daemon never bound. `03246` and `1e4` are the sharp ones: reading only the
  // leading digits would put the CLI on :03246 (octal 1702 to bash) and :1.
  test.each(["99999", "0", "03246", "1e4", "0x0C9E"])(
    "falls back to 3246 when the configured JSON port is %s",
    async (port) => {
      const root = mkdtempSync(join(tmpdir(), "echo-cli-bad-port-"));
      try {
        const home = join(root, "home");
        const bin = join(root, "bin");
        mkdirSync(join(home, ".config", "echo"), { recursive: true });
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(home, ".config", "echo", "config.json"), `{"PORT": "${port}"}`);
        writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
        writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s' '{"status":"healthy","activeProvider":"edgetts","mode":"speech","mute":{"muted":false,"scope":"all"},"play_queue":{"depth":0},"capture_guard":{"state":"idle"},"replay":{"available":0,"capacity":10},"providers":{},"config":{"valid":true,"ignored_keys":[],"retired_keys":[]}}'\nexit 0\n`);

        const r = await runCli(["status"], { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` });
        expect(r.exitCode).toBe(0);
        expect(r.stdout).toContain("running on :3246");
        expect(r.stdout).not.toContain(`:${port}`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // A last property carries no trailing comma, so the value token has to be
  // readable without one - that is how migrate-config.ts pretty-prints.
  test("reads the configured port from multi-line JSON", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-cli-multiline-port-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(
        join(home, ".config", "echo", "config.json"),
        JSON.stringify({ ECHO_DEFAULT_TITLE: "First", PORT: 3457 }, null, 2) + "\n",
      );
      writeExecutable(join(bin, "launchctl"), "#!/bin/bash\nexit 0\n");
      writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s' '{"status":"healthy","activeProvider":"edgetts","mode":"speech","mute":{"muted":false,"scope":"all"},"play_queue":{"depth":0},"capture_guard":{"state":"idle"},"replay":{"available":0,"capacity":10},"providers":{},"config":{"valid":true,"ignored_keys":[],"retired_keys":[]}}'\nexit 0\n`);

      const r = await runCli(["status"], { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("running on :3457");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const dashboardHealth = {
  status: "healthy",
  activeProvider: "edgetts",
  mode: "sounds",
  mute: { muted: false, scope: "all", muted_until: null as string | null },
  play_queue: { depth: 2 },
  capture_guard: { state: "recording" },
  replay: { available: 3, capacity: 10 },
  providers: {
    edgetts: { enabled: true, healthy: true },
    kokoro: { enabled: true, healthy: false },
    elevenlabs: { enabled: false, healthy: false },
  },
  config: { valid: true, ignored_keys: ["UNKNOWN_SETTING"], retired_keys: ["ECHO_VOICE_SAY_NAME"] },
};

async function withStatusFixture(
  check: (fixture: {
    home: string;
    project: string;
    root: string;
    env: Record<string, string>;
    write: (path: string, contents: string) => void;
    run: () => ReturnType<typeof runCli>;
  }) => Promise<void>,
  options: { bun?: boolean; offline?: boolean; health?: unknown } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "echo-status-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  const healthFile = join(root, "health.json");
  const write = (path: string, contents: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  };
  try {
    for (const dir of [home, project, bin]) mkdirSync(dir);
    for (const name of ["bash", "cat", "dirname", "grep", "sed", "head", "tail"]) {
      symlinkSync(Bun.which(name)!, join(bin, name));
    }
    if (options.bun !== false) symlinkSync(process.execPath, join(bin, "bun"));
    writeExecutable(join(bin, "launchctl"), '#!/bin/bash\necho "111 0 com.echo"\n');
    writeExecutable(join(bin, "curl"), options.offline
      ? "#!/bin/bash\nexit 7\n"
      : '#!/bin/bash\nprintf \'%s\\n\' "$@" > "$ECHO_STATUS_REQUEST"\ncat "$ECHO_STATUS_HEALTH"\n');
    writeFileSync(healthFile, JSON.stringify(options.health ?? dashboardHealth));
    const env = {
      HOME: home,
      PATH: bin,
      ECHO_STATUS_HEALTH: healthFile,
      ECHO_STATUS_REQUEST: join(root, "request.txt"),
    };
    await check({ home, project, root, env, write, run: () => runCli(["status"], env, project) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("echo status", () => {
  test("renders health and source metadata with Bun and no Python, using only GET /health", async () => {
    await withStatusFixture(async ({ home, root, write, run }) => {
      const sourcePackage = join(home, "Library/Application Support/echo/source/package.json");
      const contents = JSON.stringify({ name: "agent-echo", version: "9.8.7" });
      write(sourcePackage, contents);
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/Daemon\s+running on :3246\s+loaded/);
      expect(r.stdout).toMatch(/Mode\s+sounds/);
      expect(r.stdout).toMatch(/Provider\s+edgetts/);
      expect(r.stdout).toMatch(/Queue\s+2 waiting/);
      expect(r.stdout).toMatch(/Capture\s+recording/);
      expect(r.stdout).toMatch(/edgetts\s+ok/);
      expect(r.stdout).toMatch(/kokoro\s+unhealthy/);
      expect(r.stdout).toMatch(/elevenlabs\s+off/);
      expect(r.stdout).toMatch(/Source\s+agent-echo 9\.8\.7/);
      expect(r.stdout).toMatch(/Config\s+valid\s+ignored: UNKNOWN_SETTING\s+retired: ECHO_VOICE_SAY_NAME/);
      expect(r.stdout).not.toContain("replay");
      expect(readFileSync(sourcePackage, "utf8")).toBe(contents);
      expect(readFileSync(join(root, "request.txt"), "utf8").trim().split("\n")).toEqual([
        "--connect-timeout", "2", "--max-time", "5", "-fsS", "http://localhost:3246/health",
      ]);
    });
  });

  test.each([
    { muted: false, scope: "all", active: false },
    { muted: true, scope: "all", active: true },
    { muted: true, scope: "tts", active: true },
    { muted: false, scope: "mic", active: true },
  ])("renders mute scope $scope with speaker flag $muted", async ({ muted, scope, active }) => {
    const deadline = "2026-11-05T23:00:00.000Z";
    await withStatusFixture(async ({ run }) => {
      const r = await run();
      expect(r.exitCode).toBe(0);
      if (active) expect(r.stdout).toContain(`muted (${scope} until ${deadline})`);
      else {
        expect(r.stdout).toMatch(/Mute\s+unmuted/);
        expect(r.stdout).not.toContain(deadline);
      }
    }, { health: { ...dashboardHealth, mute: { muted, scope, muted_until: deadline } } });
  });

  test.each(["adapters/pi", "../../Echo/adapters/pi", "/Echo/adapters/pi/"])(
    "recognizes Pi's reconciled package path %s",
    async (entry) => {
      await withStatusFixture(async ({ home, write, run }) => {
        write(join(home, ".pi/agent/settings.json"), JSON.stringify({ packages: [entry] }));
        const r = await run();
        expect(r.stdout).toMatch(/Pi\s+registered\s/);
      });
    },
  );

  test.each(["npm:adapters/pi/", "https://example.com/adapters/pi", "/Echo/adapters/pi/other"])(
    "does not treat %s as an installed Pi adapter package",
    async (entry) => {
      await withStatusFixture(async ({ home, write, run }) => {
        write(join(home, ".pi/agent/settings.json"), JSON.stringify({ packages: [entry] }));
        expect((await run()).stdout).toMatch(/Pi\s+not registered/);
      });
    },
  );

  test.each([
    { config: '[hooks]\nturn_end = "/Echo/adapters/jcode/hook.ts"\n', registered: true },
    { config: 'hooks.session_start = "/Echo/adapters/jcode/hook.ts"\n', registered: true },
    { config: 'hooks = { turn_end = "/Echo/adapters/jcode/hook.ts" }\n', registered: true },
    { config: '["hooks"]\n"session_start" = "/Echo/adapters/jcode/hook.ts"\n', registered: true },
    { config: '# turn_end = "/Echo/adapters/jcode/hook.ts"\n', registered: false },
    { config: '[hooks]\nturn_end = "other" # /Echo/adapters/jcode/hook.ts\n', registered: false },
    { config: '[other]\nturn_end = "/Echo/adapters/jcode/hook.ts"\n', registered: false },
  ])("reports only active Jcode hooks: $config", async ({ config, registered }) => {
    await withStatusFixture(async ({ home, write, run }) => {
      const path = join(home, ".jcode/config.toml");
      write(path, config);
      const r = await run();
      expect(r.stdout).toMatch(registered ? /Jcode\s+registered\s/ : /Jcode\s+not registered/);
      expect(readFileSync(path, "utf8")).toBe(config);
    });
  });

  test.each(["project", "user", "custom home", "override", "project shadows user"])(
    "uses Codex registration precedence: %s",
    async (selection) => {
      await withStatusFixture(async ({ home, project, root, env, write, run }) => {
        const registered = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "bun /Echo/adapters/codex/hook.ts" }] }] } });
        write(join(home, ".codex/hooks.json"), registered);
        if (selection !== "user" && selection !== "custom home") {
          write(join(project, ".codex/hooks.json"), selection === "project" ? registered : "{}");
        }
        if (selection === "custom home") {
          env.CODEX_HOME = join(root, "custom-codex-home");
          write(join(home, ".codex/hooks.json"), "{}");
          write(join(env.CODEX_HOME, "hooks.json"), registered);
        }
        if (selection === "override") {
          env.ECHO_CODEX_HOOKS_FILE = join(root, "custom/hooks.json");
          write(env.ECHO_CODEX_HOOKS_FILE, registered);
        }
        const r = await run();
        expect(r.stdout).toMatch(selection === "project shadows user" ? /Codex\s+not registered/ : /Codex\s+registered\s/);
        if (selection === "project") expect(r.stdout).toContain(join(project, ".codex/hooks.json"));
        if (selection === "override") expect(r.stdout).toContain(env.ECHO_CODEX_HOOKS_FILE);
      });
    },
  );

  test.each([false, true])("includes MCP registration with config override %s", async (override) => {
    await withStatusFixture(async ({ home, root, env, write, run }) => {
      const path = override ? join(root, "custom-claude.json") : join(home, ".claude.json");
      if (override) env.ECHO_MCP_CONFIG_PATH = path;
      const config = JSON.stringify({ mcpServers: { "echo-converse": { type: "stdio", command: "bun", args: ["/Echo/adapters/mcp/server.ts"] } } });
      write(path, config);
      expect((await run()).stdout).toMatch(/MCP\s+registered\s/);
      expect(readFileSync(path, "utf8")).toBe(config);
    });
  });

  test("keeps local registrations and install data visible offline", async () => {
    await withStatusFixture(async ({ home, write, run }) => {
      write(join(home, ".pi/agent/settings.json"), '{"packages":["/Echo/adapters/pi"]}');
      write(join(home, "Library/Application Support/echo/source/package.json"), '{"name":"agent-echo","version":"9.8.7"}');
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("not running");
      expect(r.stdout).toMatch(/Mute\s+unavailable/);
      expect(r.stdout).toMatch(/Mode\s+unavailable/);
      expect(r.stdout).toMatch(/Provider\s+unavailable/);
      expect(r.stdout).toMatch(/Queue\s+unavailable/);
      expect(r.stdout).toMatch(/Capture\s+unavailable/);
      expect(r.stdout).toMatch(/Providers\n\s+unavailable/);
      expect(r.stdout).toMatch(/Pi\s+registered\s/);
      expect(r.stdout).toMatch(/MCP\s+not registered/);
      expect(r.stdout).toMatch(/Source\s+agent-echo 9\.8\.7/);
      expect(r.stdout).toMatch(/Config\s+unavailable/);
      expect(r.stdout).toContain("echo install --adapter none");
      expect(r.stdout).not.toContain("echo start");
    }, { offline: true });
  });

  test("reports unavailable parsing honestly when Bun is absent", async () => {
    await withStatusFixture(async ({ home, write, run }) => {
      write(join(home, "Library/Application Support/echo/source/package.json"), '{"name":"agent-echo","version":"9.8.7"}');
      write(join(home, ".jcode/config.toml"), '[hooks]\nturn_end = "/Echo/adapters/jcode/hook.ts"\n');
      const r = await run();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("running on :3246");
      expect(r.stdout).toContain("Bun unavailable");
      expect(r.stdout).toMatch(/Mute\s+unavailable/);
      expect(r.stdout).toMatch(/Config\s+unavailable/);
      expect(r.stdout).toMatch(/Source\s+unknown/);
      expect(r.stdout).toMatch(/Jcode\s+unavailable/);
      expect(r.stdout).not.toContain("unmuted");
      expect(r.stdout).not.toMatch(/Config\s+invalid/);
    }, { bun: false });
  });

  test("does not fabricate mute or config states from missing health fields", async () => {
    await withStatusFixture(async ({ run }) => {
      const r = await run();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/Mute\s+unavailable/);
      expect(r.stdout).toMatch(/Config\s+unavailable/);
    }, { health: { status: "healthy" } });
  });

  test("preserves invalid configuration and unhealthy daemon status", async () => {
    await withStatusFixture(async ({ run }) => {
      const r = await run();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/Config\s+invalid/);
      expect(r.stdout).toMatch(/Mute\s+unmuted/);
    }, { health: { ...dashboardHealth, status: "degraded", config: { valid: false } } });
  });

  test("reports an unreadable health response without hiding local sections", async () => {
    await withStatusFixture(async ({ run }) => {
      const r = await run();
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain("unreadable /health response");
      expect(r.stdout).toContain("Harnesses");
      expect(r.stdout).toContain("Install");
      expect(r.stdout).toMatch(/Config\s+unavailable/);
    }, { health: "not a health document" });
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
      expect(r.stdout).toContain("converse");
      expect(r.stdout).toContain("brew install sox");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    { label: "say-name property", config: '{"ECHO_VOICE_SAY_NAME":true}', retired: "ECHO_VOICE_SAY_NAME" },
    { label: "catchphrase property", config: '{"ECHO_VOICE_CATCHPHRASE":"Hello"}', retired: "ECHO_VOICE_CATCHPHRASE" },
    { label: "escaped say-name property", config: '{"ECHO_VOICE_SAY_NAM\\u0045":true}', retired: "ECHO_VOICE_SAY_NAME" },
    { label: "escaped catchphrase property", config: '{"ECHO_VOICE_CATCHPHRAS\\u0045":"Hello"}', retired: "ECHO_VOICE_CATCHPHRASE" },
    {
      label: "both properties with multiline whitespace",
      config: '{\n  "ECHO_VOICE_SAY_NAME"\n  : true,\r\n  "ECHO_VOICE_CATCHPHRASE"\t:\t"Hello"\n}',
      retired: "ECHO_VOICE_CATCHPHRASE, ECHO_VOICE_SAY_NAME",
    },
    { label: "say-name string value", config: '{"ECHO_DEFAULT_TITLE":"ECHO_VOICE_SAY_NAME"}', retired: "" },
    { label: "catchphrase string value", config: '{"ECHO_DEFAULT_TITLE":"ECHO_VOICE_CATCHPHRASE"}', retired: "" },
    {
      label: "quoted property text in a value",
      config: JSON.stringify({ ECHO_DEFAULT_TITLE: '{"ECHO_VOICE_SAY_NAME":true,"ECHO_VOICE_CATCHPHRASE":true}' }),
      retired: "",
    },
    {
      label: "similar property names",
      config: JSON.stringify({ ECHO_VOICE_SAY_NAME_OLD: true, ECHO_VOICE_CATCHPHRASE_OLD: true }),
      retired: "",
    },
    {
      label: "retired names inside other property names",
      config: JSON.stringify({ 'other "ECHO_VOICE_SAY_NAME': true, 'other "ECHO_VOICE_CATCHPHRASE': true }),
      retired: "",
    },
    {
      label: "overridden config path",
      config: '{"ECHO_VOICE_SAY_NAME":false,"ECHO_VOICE_CATCHPHRASE":""}',
      retired: "ECHO_VOICE_CATCHPHRASE, ECHO_VOICE_SAY_NAME",
    },
    { label: "no retired properties", config: '{"ECHO_DEFAULT_TITLE":"Kept"}', retired: "" },
  ])("doctor reports only retired properties without failing: $label", async ({ label, config, retired }) => {
    const root = mkdtempSync(join(tmpdir(), "echo-doctor-retired-"));
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const payload = join(home, "Library", "Application Support", "echo", "payload", "current");
      const launchagents = join(home, "Library", "LaunchAgents");
      const configPath = label === "overridden config path"
        ? join(root, "operator-config.json")
        : join(home, ".config", "echo", "config.json");
      mkdirSync(join(home, ".config", "echo"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      mkdirSync(join(payload, "core"), { recursive: true });
      mkdirSync(launchagents, { recursive: true });
      writeFileSync(join(payload, "core", "server.ts"), "");
      writeFileSync(join(payload, "manifest.json"), JSON.stringify({ version: "0.12.0" }));
      writeFileSync(join(launchagents, "com.echo.plist"), `<plist version="1.0"><dict>
<key>ProgramArguments</key><array><string>${join(payload, "core", "server.ts")}</string></array>
<key>WorkingDirectory</key>
<string>${payload}</string>
</dict></plist>\n`);
      writeFileSync(configPath, config);
      writeExecutable(join(bin, "uname"), '#!/bin/bash\ncase "$1" in -s) echo Darwin ;; -r) echo 26.0 ;; esac\n');
      writeExecutable(join(bin, "launchctl"), '#!/bin/bash\ncase "$1" in list) echo "111 0 com.echo" ;; *) exit 1 ;; esac\n');
      writeExecutable(join(bin, "curl"), '#!/bin/bash\necho \'{"status":"healthy"}\'\n');

      const r = await runCli(["doctor"], {
        HOME: home,
        PATH: `${bin}:${bunDir}:/bin:/usr/bin`,
        ECHO_CONVERSE_SOX_BIN: "/usr/bin/true",
        ECHO_CONVERSE_REC_BIN: "/usr/bin/true",
        ...(label === "overridden config path" ? { ECHO_CONFIG_FILE: configPath } : {}),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Result: READY");
      if (retired) {
        expect(r.stdout).toContain(`retired key(s) ignored: ${retired}`);
        expect(r.stdout).toMatch(/!\s+config/);
        expect(r.stdout).toContain(`Harmless. Remove them from ${configPath}.`);
      } else {
        expect(r.stdout).not.toContain("retired key(s)");
        expect(r.stdout).not.toContain("Harmless");
      }
      expect(r.stdout).not.toContain("not an Echo configuration key");
      expect(readFileSync(configPath, "utf8")).toBe(config);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The port is occupied and /health is silent. These three launchd states are
  // indistinguishable from outside - a foreign owner on :3246 is what stops our
  // service binding, so launchd respawns it and reports no stable PID. Doctor
  // must therefore give the same, non-committal answer in all three, naming the
  // listener and offering both recoveries rather than guessing.
  type PortOwnerState = "echo-pid-matches" | "echo-crashlooping" | "echo-not-loaded";

  function occupiedPortEnv(root: string, state: PortOwnerState) {
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeExecutable(join(bin, "curl"), "#!/bin/bash\nexit 7\n");
    writeExecutable(
      join(bin, "lsof"),
      '#!/bin/bash\nfor a in "$@"; do [ "$a" = "-t" ] && { echo 4242; exit 0; }; done\n' +
        'echo "COMMAND   PID USER"\necho "bun      4242 ed"\nexit 0\n',
    );
    // `launchctl list <label>` reports a PID for a running service and exits 113
    // when the label has none - the real tool's shape.
    const launchctl = {
      "echo-pid-matches":
        '#!/bin/bash\nif [ "$1" = "list" ] && [ -n "$2" ]; then echo \'{ "PID" = 4242; };\'; exit 0; fi\ncase "$1" in list) echo "4242 0 com.echo" ;; esac\nexit 0\n',
      "echo-crashlooping":
        '#!/bin/bash\nif [ "$1" = "list" ] && [ -n "$2" ]; then exit 113; fi\ncase "$1" in list) echo "- 1 com.echo" ;; esac\nexit 0\n',
      "echo-not-loaded": '#!/bin/bash\nif [ "$1" = "list" ] && [ -n "$2" ]; then exit 113; fi\nexit 0\n',
    }[state];
    writeExecutable(join(bin, "launchctl"), launchctl);
    return { HOME: home, PATH: `${bin}:${bunDir}:/bin:/usr/bin` };
  }

  for (const state of ["echo-pid-matches", "echo-crashlooping", "echo-not-loaded"] as const) {
    test(`an occupied port names its listener and claims no owner (${state})`, async () => {
      const root = mkdtempSync(join(tmpdir(), `echo-doctor-${state}-`));
      try {
        const r = await runCli(["doctor"], occupiedPortEnv(root, state));
        expect(r.exitCode).toBe(1);
        expect(r.stdout).toContain("Port 3246 is occupied but not answering Echo's /health");
        expect(r.stdout).toContain("Owner: bun (PID 4242)");
        // Both recoveries, because which one applies cannot be determined here.
        expect(r.stdout).toContain("restart.sh");
        expect(r.stdout).toContain("stop it and rerun");
        expect(r.stdout).toContain("never kills the port owner");
        // No ownership verdict in either direction.
        expect(r.stdout).not.toContain("which is not Echo");
        expect(r.stdout).not.toContain("com.echo holds :3246");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test.each([
    { state: "Echo owns the listener", service: "4242 0 com.echo", listeners: "4242", ready: true },
    { state: "Echo owns both address families", service: "4242 0 com.echo", listeners: "4242\n4242", ready: true },
    { state: "Echo is crash-looping", service: "- 1 com.echo", listeners: "4242", ready: false },
    { state: "Echo is not loaded", service: "", listeners: "4242", ready: false },
    { state: "another process owns the listener", service: "111 0 com.echo", listeners: "4242", ready: false },
    { state: "Echo shares the port with another listener", service: "4242 0 com.echo", listeners: "4242\n5151", ready: false },
    { state: "listener ownership is unavailable", service: "4242 0 com.echo", listeners: "", ready: false },
    { state: "a similarly named service owns the listener", service: "4242 0 com.echo.other", listeners: "4242", ready: false },
  ])("rate-limited health verifies ownership when $state", async ({ service, listeners, ready }) => {
    const root = mkdtempSync(join(process.cwd(), ".echo-doctor-rate-limit-"));
    const requests: string[] = [];
    const endpoint = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests.push(`${request.method} ${new URL(request.url).pathname}`);
        return Response.json({ status: "error", message: "Rate limit exceeded" }, { status: 429 });
      },
    });
    try {
      const home = join(root, "home");
      const bin = join(root, "bin");
      const payload = join(home, "Library/Application Support/echo/payload/current");
      const plist = join(home, "Library/LaunchAgents/com.echo.plist");
      const config = join(home, ".config/echo/config.json");
      for (const dir of [bin, join(payload, "core"), dirname(plist), dirname(config)]) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(join(payload, "core/server.ts"), "");
      writeFileSync(join(payload, "manifest.json"), JSON.stringify({ version: "test" }));
      writeFileSync(plist, `<plist version="1.0"><dict>
<key>ProgramArguments</key><array><string>${join(payload, "core/server.ts")}</string></array>
<key>WorkingDirectory</key>
<string>${payload}</string>
</dict></plist>\n`);
      writeFileSync(config, JSON.stringify({ PORT: endpoint.port }));
      writeExecutable(join(bin, "uname"), '#!/bin/bash\necho Darwin\n');
      writeExecutable(join(bin, "launchctl"), `#!/bin/bash\nprintf '%s\\n' '${service}'\n`);
      writeExecutable(join(bin, "lsof"), `#!/bin/bash\nprintf '%s\\n' '${listeners}'\n`);

      const r = await runCli(["doctor"], {
        HOME: home,
        PATH: `${bin}:${bunDir}:/bin:/usr/bin`,
        ECHO_CONVERSE_SOX_BIN: "/usr/bin/true",
        ECHO_CONVERSE_REC_BIN: "/usr/bin/true",
      });
      expect(requests).toEqual(["GET /health"]);
      expect(r.stdout).toContain("plist + host adapter paths current");
      expect(r.stdout).not.toContain("configured TTS providers healthy");
      expect(r.stdout).not.toContain("is occupied but not answering Echo's /health");
      if (ready) {
        expect(r.stdout).toContain("service healthy, retry in a minute");
        expect(r.stdout).toContain("Result: READY");
        expect(r.exitCode).toBe(0);
      } else {
        expect(r.stdout).toContain("HTTP 429");
        expect(r.stdout).toContain("Echo health unverified");
        expect(r.stdout).not.toContain("service healthy");
        expect(r.stdout).toContain("Result: DEGRADED");
        expect(r.exitCode).toBe(1);
      }
    } finally {
      endpoint.stop(true);
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
      // healthy provider ahead of it - the row must not depend on field order.
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
        const env = {
          HOME: home,
          PATH: `${bin}:${bunDir}:/bin:/usr/bin:/usr/sbin:/sbin`,
          // This test exercises doctor readiness with a hermetic fixture. The
          // real install path still requires sox/rec, while overrides make the
          // dependency row deterministic on CI hosts without Homebrew.
          ECHO_CONVERSE_SOX_BIN: "/usr/bin/true",
          ECHO_CONVERSE_REC_BIN: "/usr/bin/true",
        };

        // A live Echo clone hook (the FM-342 mess): install must rewrite it onto
        // this checkout so doctor registrations are current, not DEGRADED.
        const otherHook = join(root, "Atlas", "Echo", "adapters", "jcode", "hook.ts");
        mkdirSync(dirname(otherHook), { recursive: true });
        writeFileSync(join(dirname(otherHook), "package.json"), JSON.stringify({ name: "@echo/jcode-adapter" }));
        writeFileSync(otherHook, "#!/usr/bin/env bun\n");
        mkdirSync(join(home, ".jcode"), { recursive: true });
        writeFileSync(
          join(home, ".jcode/config.toml"),
          `[hooks]\nturn_end = ${JSON.stringify(otherHook)}\nsession_start = ${JSON.stringify(otherHook)}\n`,
        );

        // Stage the payload first (install.sh runs in the same temp HOME).
        const install = await runCli(["install", "--adapter", "none"], env);
        expect(install.exitCode).toBe(0);
        const jcodeAfter = readFileSync(join(home, ".jcode/config.toml"), "utf8");
        expect(jcodeAfter).not.toContain(otherHook);
        expect(jcodeAfter).toContain("adapters/jcode/hook.ts");

        const r = await runCli(["doctor"], env);
        expect(r.stdout).toContain("Result: READY");
        expect(r.stdout).toContain("plist + host adapter paths current");
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

  test("toggle, status, and off dispatch to mute.sh (never the live daemon)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mute-verbs-"));
    try {
      const { env, log } = muteEnv(root);
      expect((await runCli(["mute", "toggle"], env)).exitCode).toBe(0);
      expect((await runCli(["mute", "status"], env)).exitCode).toBe(0);
      expect((await runCli(["mute", "off"], env)).exitCode).toBe(0);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain("/mute");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("on tts and 30m tts pass scope through to mute.sh", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mute-scope-"));
    try {
      const { env, log } = muteEnv(root);
      expect((await runCli(["mute", "on", "tts"], env)).exitCode).toBe(0);
      expect((await runCli(["mute", "30m", "tts"], env)).exitCode).toBe(0);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain('"scope": "tts"');
      expect(logged).toContain('"duration_minutes": 30');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("toggle all POSTs an empty body (legacy #83 toggle), not {scope:all}", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-mute-toggle-all-"));
    try {
      const { env, log } = muteEnv(root);
      expect((await runCli(["mute", "toggle", "all"], env)).exitCode).toBe(0);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain("/mute");
      expect(logged).not.toContain('"scope": "all"');
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

describe("echo replay", () => {
  function replayEnv(root: string): { env: Record<string, string>; log: string } {
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    const log = join(root, "curl-args.log");
    writeExecutable(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\necho '{"status":"accepted","replayed":1}'\nexit 0\n`);
    return { env: { HOME: join(root, "home"), PATH: `${bin}:${bunDir}:/bin:/usr/bin` }, log };
  }

  test("default and explicit n POST /replay (never the live daemon)", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-replay-"));
    try {
      const { env, log } = replayEnv(root);
      expect((await runCli(["replay"], env)).exitCode).toBe(0);
      expect((await runCli(["replay", "3"], env)).exitCode).toBe(0);
      const logged = readFileSync(log, "utf8");
      expect(logged).toContain("/replay");
      expect(logged).toContain('"n": 1');
      expect(logged).toContain('"n": 3');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects abusive n before touching the daemon", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-replay-bad-"));
    try {
      const { env, log } = replayEnv(root);
      expect((await runCli(["replay", "0"], env)).exitCode).toBe(2);
      expect((await runCli(["replay", "11"], env)).exitCode).toBe(2);
      expect((await runCli(["replay", "banana"], env)).exitCode).toBe(2);
      expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("/replay");
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
      const configFile = join(home, ".config/echo/config.json");
      for (const f of [join(payload, "versions/0.0.0/core/server.ts"), muteState, plist, log, configFile]) {
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
      expect(existsSync(configFile)).toBe(true);
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
  test("merge-writes the default persona JSON config, preserving unrelated keys", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-"));
    try {
      const configFile = join(root, "config.json");
      writeFileSync(configFile, JSON.stringify({ unrelated: "keepme", ECHO_VOICE_ID: "old-value" }));
      const env = {
        HOME: join(root, "home"),
        PATH: `${bunDir}:/bin:/usr/bin`,
        ECHO_CONFIG_FILE: configFile,
      };

      const r = await runCli(["voice", "Echo", "en-US-AndrewNeural"], env);
      expect(r.exitCode).toBe(0);

      const written = JSON.parse(readFileSync(configFile, "utf8"));
      expect(written.ECHO_VOICE_PERSONA_NAME).toBe("Echo");
      expect(written.ECHO_VOICE_ID).toBe("en-US-AndrewNeural");
      expect(written.ECHO_VOICE_SUPPRESS_SUBAGENTS).toBe(true);
      expect(written.unrelated).toBe("keepme");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("supports an explicit subagent voice opt-in for automation", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-subagents-"));
    try {
      const configFile = join(root, "config.json");
      const env = {
        HOME: join(root, "home"),
        PATH: `${bunDir}:/bin:/usr/bin`,
        ECHO_CONFIG_FILE: configFile,
      };

      const r = await runCli(["voice", "Echo", "en-US-AndrewNeural", "--allow-subagents"], env);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(configFile, "utf8")).ECHO_VOICE_SUPPRESS_SUBAGENTS).toBe(false);

      const suppress = await runCli(["voice", "Echo", "en-US-AndrewNeural", "--suppress-subagents"], env);
      expect(suppress.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(configFile, "utf8")).ECHO_VOICE_SUPPRESS_SUBAGENTS).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a persona name that would inject extra env lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-inject-"));
    try {
      const configFile = join(root, "config.json");
      writeFileSync(configFile, JSON.stringify({ unrelated: "keepme" }));
      const env = {
        HOME: join(root, "home"),
        PATH: `${bunDir}:/bin:/usr/bin`,
        ECHO_CONFIG_FILE: configFile,
      };

      const r = await runCli(["voice", 'Echo"\nELEVENLABS_API_KEY=stolen', "en-US-AndrewNeural"], env);
      expect(r.exitCode).toBe(2);
      // The JSON config is left untouched.
      expect(readFileSync(configFile, "utf8")).toBe(JSON.stringify({ unrelated: "keepme" }));
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
        ECHO_CONFIG_FILE: join(root, "config.json"),
      };
      const r = await runCli(["voice", "Echo", "not-a-voice"], env);
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("edge-tts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

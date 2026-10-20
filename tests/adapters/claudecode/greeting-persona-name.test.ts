import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesStartupGreeting } from "../../../adapters/claudecode/hooks/lib/greeting";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function runGreeting(
  source: string,
  config: Record<string, unknown> = {},
  extraEnv: Record<string, string> = {},
): Promise<unknown[]> {
  const home = mkdtempSync(join(tmpdir(), "echo-claude-startup-"));
  scratch.push(home);
  const project = join(home, "project");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    daidentity: { name: "Atlas", startupCatchphrases: ["Atlas online."], sayName: true },
  }));
  writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({
    daidentity: { name: "Echo", voices: { main: { voiceId: "en-GB-LibbyNeural" } } },
  }));
  const payloads: unknown[] = [];
  const receiver = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      payloads.push(await request.json());
      return new Response("accepted", { status: 202 });
    },
  });
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ ECHO_DAEMON_URL: `http://127.0.0.1:${receiver.port}`, ...config }));
  try {
    const child = Bun.spawn([process.execPath, "adapters/claudecode/hooks/VoiceGreeting.hook.ts"], {
      env: {
        ...process.env,
        HOME: home,
        CLAUDE_PROJECT_DIR: project,
        ECHO_CONFIG_FILE: configPath,
        PAI_SUPPRESS_VOICE: "false",
        CLAUDE_CODE_AGENT_TASK_ID: "",
        CLAUDE_AGENT_TYPE: "",
        HERDR_SOCKET_PATH: "",
        HERDR_SESSION: "",
        HERDR_CONFIG_PATH: "",
        TERM_PROGRAM: "echo-test-unsupported",
        TERM: "dumb",
        KITTY_WINDOW_ID: "",
        ITERM_SESSION_ID: "",
        ...extraEnv,
      },
      stdin: new Blob([JSON.stringify({ source, session_id: "root-startup" })]),
      stdout: "ignore",
      stderr: "pipe",
    });
    const stderr = new Response(child.stderr).text();
    const exitCode = await child.exited;
    const detail = await stderr;
    if (exitCode !== 0) throw new Error(`Greeting hook exited ${exitCode}: ${detail}`);
    return payloads;
  } finally {
    receiver.stop(true);
  }
}

describe("Claude Code startup speech", () => {
  test("identifies the harness while keeping the project persona voice", async () => {
    expect(await runGreeting("startup")).toEqual([
      expect.objectContaining({ message: "Claude code, ready.", voice_id: "en-GB-LibbyNeural" }),
    ]);
  });

  test("an explicit greeting disable sends nothing", async () => {
    expect(await runGreeting("startup", { ECHO_VOICE_GREET_ON_START: false })).toEqual([]);
  });

  test.each(["resume", "compact", "reload", "unknown"])("%s does not announce startup", async (source) => {
    expect(await runGreeting(source)).toEqual([]);
  });

  test("a task worker does not announce the parent harness", async () => {
    expect(await runGreeting("startup", {}, { CLAUDE_CODE_AGENT_TASK_ID: "child-task" })).toEqual([]);
  });

  test("completion suppression matches only the complete startup announcement", () => {
    expect(matchesStartupGreeting("CLAUDE CODE, ready!")).toBe(true);
    expect(matchesStartupGreeting("Claude code, ready. The tests passed.")).toBe(false);
    expect(matchesStartupGreeting("Engaged!")).toBe(false);
  });
});

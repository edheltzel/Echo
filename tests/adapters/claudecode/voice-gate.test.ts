import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decideVoiceGate } from "../../../adapters/claudecode/hooks/lib/voice-gate";
import { shouldSuppressSubagentVoice } from "../../../shared/echo-env";

const subagentVoiceInput = {
  tool_name: "Bash",
  tool_input: { command: "curl -fsS http://localhost:3246/notify -d '{\"message\":\"hello\"}'" },
  session_id: "session-1",
  agent_id: "agent-1",
  agent_type: "worker",
};

describe("Claude Code VoiceGate", () => {
  async function runHook(configValue: boolean): Promise<unknown> {
    const root = mkdtempSync(join(tmpdir(), "echo-voice-gate-"));
    try {
      const configFile = join(root, "config.json");
      writeFileSync(configFile, JSON.stringify({ ECHO_VOICE_SUPPRESS_SUBAGENTS: configValue }));
      const child = Bun.spawn(["bun", "run", resolve("adapters/claudecode/hooks/VoiceGate.hook.ts")], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: join(root, "home"), ECHO_CONFIG_FILE: configFile },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      child.stdin.write(JSON.stringify(subagentVoiceInput));
      await child.stdin.flush();
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toContain("subagent voice curl");
      return JSON.parse(stdout.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("defaults to suppressing subagent voice", () => {
    expect(shouldSuppressSubagentVoice({})).toBe(true);
    expect(decideVoiceGate(subagentVoiceInput, true)).toEqual({
      decision: "block",
      reason: expect.stringContaining("suppressed by default"),
    });
  });

  test("allows an explicit opt-in while keeping main-session behavior", () => {
    expect(shouldSuppressSubagentVoice({ ECHO_VOICE_SUPPRESS_SUBAGENTS: "false" })).toBe(false);
    expect(decideVoiceGate(subagentVoiceInput, false)).toEqual({ continue: true });
    expect(
      decideVoiceGate({ ...subagentVoiceInput, agent_id: undefined }, true),
    ).toEqual({ continue: true });
  });

  test("does not gate unrelated Bash commands even when subagents are suppressed", () => {
    expect(
      decideVoiceGate(
        { ...subagentVoiceInput, tool_input: { command: "curl -fsS https://example.com/health" } },
        true,
      ),
    ).toEqual({ continue: true });
  });

  test("reads the persisted policy in the hook process", async () => {
    expect(await runHook(true)).toEqual({
      decision: "block",
      reason: expect.stringContaining("suppressed by default"),
    });
    expect(await runHook(false)).toEqual({ continue: true });
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  extractFallbackSummary,
  handleGrokHook,
  handleGrokHookResult,
  messageFromStop,
  type GrokHookPayload,
} from "../../../adapters/grok/hook.ts";
import { loadGrokVoiceConfig, type GrokVoiceConfig } from "../../../adapters/grok/config.ts";

const originalFetch = globalThis.fetch;
const fixtures = resolve("tests/adapters/grok/fixtures");

function loadFixture(name: string): GrokHookPayload {
  return JSON.parse(readFileSync(resolve(fixtures, name), "utf8")) as GrokHookPayload;
}

const config: GrokVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "Grok Notification",
  startupCatchphrases: ["{name} online."],
  personaName: "Grok",
  sayName: true,
  voiceId: "grok",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Grok lifecycle hook adapter", () => {
  test("captured real Stop end_turn payload produces /notify via fallback summary", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    const fixture = loadFixture("stop-end-turn.json");
    expect(fixture.hookEventName).toBe("stop");
    expect(fixture.reason).toBe("end_turn");
    expect(fixture.lastAssistantMessage).toBe("Hello from Echo capture.");

    const spoken = await handleGrokHook(fixture, config);
    expect(spoken).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual(expect.objectContaining({
      message: "Hello from Echo capture.",
      title: "Grok Notification",
      voice_enabled: true,
      voice_id: "grok",
      session_id: fixture.sessionId,
      source: "grok",
    }));
  });

  test("speaks an explicit final voice line on end_turn", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    const fixture = loadFixture("stop-end-turn-voice-line.json");
    expect(await handleGrokHook(fixture, config)).toBe(true);
    expect(payloads[0]).toEqual(expect.objectContaining({
      message: "Added and verified the new Echo adapter.",
      source: "grok",
      session_id: fixture.sessionId,
    }));
  });

  test("session-end Stop (reason shutdown) stays silent", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    expect(await handleGrokHook(loadFixture("stop-shutdown.json"), config)).toBe(false);
    expect(calls).toBe(0);
  });

  test("suppresses SubagentStop so fan-out does not speak", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    expect(await handleGrokHook(loadFixture("subagent-stop.json"), config)).toBe(false);
    expect(calls).toBe(0);
  });

  test("session greeting is opt-in and only for new sessions", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    const fixture = loadFixture("session-start.json");
    expect(fixture.source).toBe("new");
    expect(await handleGrokHook(fixture, config)).toBe(false);

    expect(await handleGrokHook(fixture, { ...config, greetOnSessionStart: true })).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      message: "Grok online.",
      source: "grok",
      session_id: fixture.sessionId,
    });

    expect(await handleGrokHook(
      { ...fixture, source: "resume" },
      { ...config, greetOnSessionStart: true },
    )).toBe(false);
  });

  test("distinguishes skipped hooks from notify failures", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503, statusText: "Unavailable" });

    expect(await handleGrokHookResult(loadFixture("stop-shutdown.json"), config)).toBe("skipped");
    expect(await handleGrokHookResult(loadFixture("stop-end-turn.json"), config)).toBe("failed");
  });

  test("messageFromStop prefers voice line over fallback", () => {
    expect(messageFromStop("Done.\n🗣️ Grok: Wired the adapter.")).toBe("Wired the adapter.");
    expect(extractFallbackSummary("Hello from Echo capture.")).toBe("Hello from Echo capture.");
  });

  test("preserves notify URL aliases for Grok config", () => {
    expect(loadGrokVoiceConfig({ ATLAS_VOICE_NOTIFY_URL: "http://127.0.0.1:8899/notify" }, undefined, "/tmp/echo-absent-home").endpoint)
      .toBe("http://127.0.0.1:8899/notify");
  });

  test("executable exits zero for skipped hooks and nonzero for notify failures", async () => {
    const hookPath = new URL("../../../adapters/grok/hook.ts", import.meta.url).pathname;
    const baseEnv = {
      ...process.env,
      ECHO_NOTIFY_URL: "http://127.0.0.1:9/notify",
      ECHO_VOICE_SPEAK_COMPLETIONS: "true",
    };

    const skipped = Bun.spawnSync({
      cmd: ["bun", hookPath],
      env: baseEnv,
      stdin: new Blob([JSON.stringify(loadFixture("stop-shutdown.json"))]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(skipped.exitCode).toBe(0);

    const failed = Bun.spawnSync({
      cmd: ["bun", hookPath],
      env: baseEnv,
      stdin: new Blob([JSON.stringify(loadFixture("stop-end-turn.json"))]),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(failed.exitCode).not.toBe(0);
  });
});

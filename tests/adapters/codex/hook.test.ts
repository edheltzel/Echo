import { afterEach, describe, expect, test } from "bun:test";
import {
  extractFallbackSummary,
  handleCodexHook,
  messageFromStop,
  normalizeHookEvent,
  type CodexHookPayload,
} from "../../../adapters/codex/hook.ts";
import {
  applyPersonaOverride,
  loadCodexVoiceConfig,
  loadProjectPersona,
  type CodexVoiceConfig,
} from "../../../adapters/codex/config.ts";

const originalFetch = globalThis.fetch;

const config: CodexVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "Codex Notification",
  startupCatchphrases: ["{name} online."],
  personaName: "Codex",
  sayName: true,
  voiceId: "codex",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Codex lifecycle hook adapter", () => {
  test("Stop with last_assistant_message produces /notify", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    const fixture: CodexHookPayload = {
      hook_event_name: "Stop",
      session_id: "sess-1",
      last_assistant_message: "Hello from Codex capture.",
    };

    expect(normalizeHookEvent(fixture)).toBe("stop");
    expect(await handleCodexHook(fixture, config)).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual(expect.objectContaining({
      message: "Hello from Codex capture.",
      title: "Codex Notification",
      voice_enabled: true,
      voice_id: "codex",
      session_id: "sess-1",
      source: "codex",
    }));
  });

  test("speaks an explicit final voice line", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    const fixture: CodexHookPayload = {
      hookEventName: "Stop",
      lastAssistantMessage: "🗣️ Themis: Adapter registered and verified.",
      sessionId: "sess-2",
    };
    expect(await handleCodexHook(fixture, config)).toBe(true);
    expect(payloads[0]).toEqual(expect.objectContaining({
      message: "Adapter registered and verified.",
      source: "codex",
    }));
  });

  test("session_start greeting is opt-in", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };
    const fixture: CodexHookPayload = { hook_event_name: "SessionStart" };
    expect(await handleCodexHook(fixture, config)).toBe(false);
    expect(calls).toBe(0);

    const greet = { ...config, greetOnSessionStart: true };
    expect(await handleCodexHook(fixture, greet)).toBe(true);
    expect(calls).toBe(1);
  });

  test("messageFromStop and fallback helpers", () => {
    expect(messageFromStop("🗣️ Atlas: Shipshape.")).toBe("Shipshape.");
    expect(extractFallbackSummary("Short enough line here.")).toBe("Short enough line here.");
  });

  test("project daidentity overrides env defaults", () => {
    const files: Record<string, string> = {
      "/proj/.codex/settings.json": JSON.stringify({
        daidentity: {
          name: "Themis",
          voices: { main: { voiceId: "en-GB-LibbyNeural" } },
        },
      }),
    };
    const read = (path: string) => files[path] ?? null;
    const override = loadProjectPersona("/proj", read, "/home");
    expect(override).toEqual({
      personaName: "Themis",
      voiceId: "en-GB-LibbyNeural",
    });
    const base = loadCodexVoiceConfig({ ECHO_VOICE_PERSONA_NAME: "Codex" }, undefined, "/tmp/echo-absent-home");
    const resolved = applyPersonaOverride(base, override);
    expect(resolved.personaName).toBe("Themis");
    expect(resolved.voiceId).toBe("en-GB-LibbyNeural");
  });

  test("defaults are independent of operator global daidentity", () => {
    const resolved = loadCodexVoiceConfig({}, undefined, "/tmp/echo-absent-home");
    expect(resolved.personaName).toBe("Codex");
    expect(resolved.voiceId).toBe("codex");
    expect(resolved.sayName).toBe(false);
  });

  test("project persona preserves a custom base greeting", () => {
    const resolved = applyPersonaOverride(config, { personaName: "Themis", sayName: false });
    expect(resolved.startupCatchphrases).toBe(config.startupCatchphrases);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import {
  extractFallbackSummary,
  handleCodexHook,
  messageFromStop,
  normalizeHookEvent,
  type CodexHookPayload,
} from "../../../adapters/codex/hook.ts";
import { applyPersonaOverride } from "../../../shared/persona.ts";
import {
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

  test("defaults to the Codex persona when no daidentity is present", () => {
    const resolved = loadCodexVoiceConfig({}, undefined);
    expect(resolved.personaName).toBe("Codex");
    expect(resolved.voiceId).toBe("codex");
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
    const base = loadCodexVoiceConfig({ ECHO_VOICE_PERSONA_NAME: "Codex" }, undefined);
    const resolved = applyPersonaOverride(base, override);
    expect(resolved.personaName).toBe("Themis");
    expect(resolved.voiceId).toBe("en-GB-LibbyNeural");
  });

  test("global-only daidentity applies when no project file", () => {
    const override = loadProjectPersona("/proj", (path) => (
      path === "/home/.codex/settings.json"
        ? JSON.stringify({ daidentity: { name: "GlobalCodex", voiceId: "en-US-AvaNeural" } })
        : null
    ), "/home");
    expect(override).toEqual({ personaName: "GlobalCodex", voiceId: "en-US-AvaNeural" });
  });

  test("project wins per key; unset project keys fall through to global", () => {
    const files: Record<string, string> = {
      "/home/.codex/settings.json": JSON.stringify({
        daidentity: {
          name: "GlobalCodex",
          voices: { main: { voiceId: "global-voice" } },
          startupCatchphrases: ["Global line."],
        },
      }),
      "/proj/.codex/settings.json": JSON.stringify({
        daidentity: { voices: { main: { voiceId: "en-GB-ThomasNeural" } } },
      }),
    };
    expect(loadProjectPersona("/proj", (path) => files[path] ?? null, "/home")).toEqual({
      personaName: "GlobalCodex",
      voiceId: "en-GB-ThomasNeural",
      startupCatchphrases: ["Global line."],
    });
  });
});

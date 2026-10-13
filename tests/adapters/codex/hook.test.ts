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
      speak_mode: "announce",
      slot: "done",
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

  test("SessionStart greets only when source is startup", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };
    const start = { hook_event_name: "SessionStart" };
    const greet = { ...config, greetOnSessionStart: true };
    expect(await handleCodexHook(start, greet)).toBe(false);
    expect(await handleCodexHook({ ...start, source: "startup" }, config)).toBe(false);
    expect(await handleCodexHook({ ...start, source: "startup" }, greet)).toBe(true);
    for (const source of ["resume", "clear", "compact", "fork", "attach", "reload"]) {
      expect(await handleCodexHook({ ...start, source }, greet)).toBe(false);
    }
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ source: "codex" });
    expect(payloads[0]).not.toHaveProperty("slot");
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
    const base = loadCodexVoiceConfig({ ECHO_VOICE_PERSONA_NAME: "Codex" }, undefined);
    expect(base.greetOnSessionStart).toBe(true);
    expect(loadCodexVoiceConfig({ ECHO_VOICE_GREET_ON_START: "false" }, undefined).greetOnSessionStart).toBe(false);
    const resolved = applyPersonaOverride(base, override);
    expect(resolved.personaName).toBe("Themis");
    expect(resolved.voiceId).toBe("en-GB-LibbyNeural");
  });

});

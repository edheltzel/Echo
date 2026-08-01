import { afterEach, describe, expect, test } from "bun:test";
import { handleJcodeHook } from "../../../adapters/jcode/hook.ts";
import type { JcodeVoiceConfig } from "../../../adapters/jcode/config.ts";

const originalFetch = globalThis.fetch;

const config: JcodeVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "Jcode Notification",
  startupCatchphrases: ["{name} online."],
  personaName: "Jcode",
  voiceId: "jcode",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Jcode lifecycle hook adapter", () => {
  test("speaks an explicit final voice line on a successful turn", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    const spoken = await handleJcodeHook({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "ok",
      JCODE_HOOK_SESSION_ID: "ses-1",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "Finished the integration.\n🗣️ Jcode: Added and verified the new Echo adapter.",
    }, config);

    expect(spoken).toBe(true);
    expect(payloads).toEqual([{
      message: "Added and verified the new Echo adapter.",
      title: "Jcode Notification",
      voice_enabled: true,
      voice_id: "jcode",
      session_id: "ses-1",
      source: "jcode",
    }]);
  });

  test("does not speak ordinary assistant text or failed turns", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    expect(await handleJcodeHook({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "ok",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "A long response without an explicit spoken line.",
    }, config)).toBe(false);
    expect(await handleJcodeHook({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "error",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "🗣️ This should stay silent.",
    }, config)).toBe(false);
    expect(calls).toBe(0);
  });

  test("session greeting is opt-in", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };

    expect(await handleJcodeHook({ JCODE_HOOK_EVENT: "session_start" }, config)).toBe(false);
    expect(await handleJcodeHook(
      { JCODE_HOOK_EVENT: "session_start", JCODE_HOOK_SESSION_ID: "ses-2" },
      { ...config, greetOnSessionStart: true },
    )).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ message: "Jcode online.", source: "jcode", session_id: "ses-2" });
  });
});

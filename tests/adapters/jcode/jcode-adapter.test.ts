import { afterEach, describe, expect, test } from "bun:test";
import { handleJcodeHook, handleJcodeHookResult } from "../../../adapters/jcode/hook.ts";
import { loadJcodeVoiceConfig, type JcodeVoiceConfig } from "../../../adapters/jcode/config.ts";

const originalFetch = globalThis.fetch;

const config: JcodeVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "Jcode Notification",
  startupCatchphrases: ["{name} online."],
  personaName: "Jcode",
  sayName: true,
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
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual(expect.objectContaining({
      message: "Added and verified the new Echo adapter.",
      title: "Jcode Notification",
      voice_enabled: true,
      voice_id: "jcode",
      session_id: "ses-1",
      source: "jcode",
    }));

    const visualDelivery = (payloads[0] as { visual_delivery?: unknown }).visual_delivery;
    expect(visualDelivery === undefined || visualDelivery === "native").toBe(true);
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

    expect(await handleJcodeHook({ JCODE_HOOK_EVENT: "session_start", JCODE_HOOK_SOURCE: "create" }, config)).toBe(false);
    expect(await handleJcodeHook(
      { JCODE_HOOK_EVENT: "session_start", JCODE_HOOK_SOURCE: "create", JCODE_HOOK_SESSION_ID: "ses-2" },
      { ...config, greetOnSessionStart: true },
    )).toBe(true);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ message: "Jcode online.", source: "jcode", session_id: "ses-2" });
  });

  test("greets only newly created sessions", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    const greetingConfig = { ...config, greetOnSessionStart: true };
    expect(await handleJcodeHook({ JCODE_HOOK_EVENT: "session_start", JCODE_HOOK_SOURCE: "resume" }, greetingConfig)).toBe(false);
    expect(await handleJcodeHook({ JCODE_HOOK_EVENT: "session_start" }, greetingConfig)).toBe(false);
    expect(calls).toBe(0);
  });

  test("suppresses child sessions by session kind or parent id", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    expect(await handleJcodeHook({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "ok",
      JCODE_HOOK_SESSION_KIND: "child",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "🗣️ Child should stay silent.",
    }, config)).toBe(false);
    expect(await handleJcodeHook({
      JCODE_HOOK_EVENT: "session_start",
      JCODE_HOOK_SOURCE: "create",
      JCODE_HOOK_PARENT_SESSION_ID: "parent-1",
    }, { ...config, greetOnSessionStart: true })).toBe(false);
    expect(calls).toBe(0);
  });

  test("suppresses long-tail child session env values with whitespace and case drift", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("{}", { status: 202 });
    };

    expect(await handleJcodeHook({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "ok",
      JCODE_HOOK_SESSION_KIND: " SubAgent ",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "🗣️ Long-tail env child should stay silent.",
    }, config)).toBe(false);
    expect(calls).toBe(0);
  });

  test("distinguishes skipped hooks from actual notification failures", async () => {
    globalThis.fetch = async () => new Response("nope", { status: 503, statusText: "Unavailable" });

    expect(await handleJcodeHookResult({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "ok",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "No marker.",
    }, config)).toBe("skipped");
    expect(await handleJcodeHookResult({
      JCODE_HOOK_EVENT: "turn_end",
      JCODE_HOOK_STATUS: "ok",
      JCODE_HOOK_LAST_ASSISTANT_TEXT: "🗣️ This failure should be reported.",
    }, config)).toBe("failed");
  });

  test("preserves supported long-tail notify URL aliases for Jcode config", () => {
    expect(loadJcodeVoiceConfig({ ATLAS_VOICE_NOTIFY_URL: "http://127.0.0.1:8899/notify" }).endpoint)
      .toBe("http://127.0.0.1:8899/notify");
  });

  test("defaults voice_id to en-HK-SamNeural", () => {
    expect(loadJcodeVoiceConfig({}).voiceId).toBe("en-HK-SamNeural");
    expect(loadJcodeVoiceConfig({ ECHO_VOICE_ID: "custom" }).voiceId).toBe("custom");
  });

  test("executable exits zero for skipped hooks and nonzero for notify failures", async () => {
    const hookPath = new URL("../../../adapters/jcode/hook.ts", import.meta.url).pathname;
    const baseEnv = {
      ...process.env,
      ECHO_NOTIFY_URL: "http://127.0.0.1:9/notify",
      ECHO_VOICE_SPEAK_COMPLETIONS: "true",
    };

    const skipped = Bun.spawnSync({
      cmd: ["bun", hookPath],
      env: {
        ...baseEnv,
        JCODE_HOOK_EVENT: "turn_end",
        JCODE_HOOK_STATUS: "ok",
        JCODE_HOOK_LAST_ASSISTANT_TEXT: "No explicit marker.",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(skipped.exitCode).toBe(0);

    const failed = Bun.spawnSync({
      cmd: ["bun", hookPath],
      env: {
        ...baseEnv,
        JCODE_HOOK_EVENT: "turn_end",
        JCODE_HOOK_STATUS: "ok",
        JCODE_HOOK_LAST_ASSISTANT_TEXT: "🗣️ This should attempt notify and fail.",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(failed.exitCode).not.toBe(0);
  });
});

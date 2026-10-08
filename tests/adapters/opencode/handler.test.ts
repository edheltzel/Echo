import { afterEach, describe, expect, test } from "bun:test";
import {
  eventSessionID,
  eventType,
  extractFallbackSummary,
  handleOpenCodeEvent,
  lastAssistantTextFromMessages,
  messageFromAssistantText,
  resetSpokenKeys,
  type OpenCodeSessionPort,
} from "../../../adapters/opencode/handler.ts";
import { loadOpenCodeVoiceConfig, type OpenCodeVoiceConfig } from "../../../adapters/opencode/config.ts";

const originalFetch = globalThis.fetch;

const config: OpenCodeVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "OpenCode Notification",
  startupCatchphrases: ["{name} online."],
  personaName: "OpenCode",
  sayName: true,
  voiceId: "opencode",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
};

function port(opts: {
  parentID?: string;
  text?: string;
  missing?: boolean;
} = {}): OpenCodeSessionPort {
  return {
    async getSession(id) {
      if (opts.missing) return null;
      return { id, parentID: opts.parentID };
    },
    async lastAssistantText() {
      return opts.text ?? "";
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSpokenKeys();
});

describe("OpenCode plugin event adapter", () => {
  test("session.idle with a voice line posts /notify", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    }) as typeof fetch;

    const result = await handleOpenCodeEvent(
      { type: "session.idle", properties: { sessionID: "ses_1" } },
      config,
      port({ text: "Done.\n\n🗣️ OpenCode: Wired the notify path." }),
    );
    expect(result).toBe("sent");
    expect(bodies).toEqual([
      expect.objectContaining({
        message: "Wired the notify path.",
        source: "opencode",
        session_id: "ses_1",
        voice_id: "opencode",
      }),
    ]);
  });

  test("session.idle without a voice line uses the fallback summary", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    }) as typeof fetch;

    const result = await handleOpenCodeEvent(
      { type: "session.idle", sessionID: "ses_2" },
      config,
      port({ text: "The adapter now speaks the last assistant turn." }),
    );
    expect(result).toBe("sent");
    expect(bodies).toEqual([
      expect.objectContaining({
        message: "The adapter now speaks the last assistant turn.",
        source: "opencode",
      }),
    ]);
  });

  test("subagent sessions with parentID stay silent", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const result = await handleOpenCodeEvent(
      { type: "session.idle", properties: { sessionID: "ses_child" } },
      config,
      port({ parentID: "ses_parent", text: "Child finished the tool call." }),
    );
    expect(result).toBe("skipped");
    expect(called).toBe(false);
  });

  test("unknown parentID from session.get fails closed", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const result = await handleOpenCodeEvent(
      { type: "session.idle", sessionID: "ses_unknown" },
      config,
      port({ missing: true, text: "Should not speak." }),
    );
    expect(result).toBe("skipped");
    expect(called).toBe(false);
  });

  test("session greeting is opt-in and only for session.created", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    }) as typeof fetch;

    const skipped = await handleOpenCodeEvent(
      { type: "session.created", properties: { info: { id: "ses_3" } } },
      config,
      port(),
    );
    expect(skipped).toBe("skipped");

    const sent = await handleOpenCodeEvent(
      { type: "session.created", properties: { info: { id: "ses_3" } } },
      { ...config, greetOnSessionStart: true },
      port(),
    );
    expect(sent).toBe("sent");
    expect(bodies).toEqual([
      expect.objectContaining({ message: "OpenCode online.", source: "opencode" }),
    ]);
  });

  test("repeats of the same idle message are deduped", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const event = { type: "session.idle", sessionID: "ses_4" };
    const lookup = port({ text: "Same spoken line every time." });
    expect(await handleOpenCodeEvent(event, config, lookup)).toBe("sent");
    expect(await handleOpenCodeEvent(event, config, lookup)).toBe("skipped");
    expect(calls).toBe(1);
  });

  test("unknown events and notify failures are distinct", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect(await handleOpenCodeEvent({ type: "session.status", sessionID: "ses_5" }, config, port())).toBe("skipped");
    expect(
      await handleOpenCodeEvent(
        { type: "session.idle", sessionID: "ses_5" },
        config,
        port({ text: "Need a real spoken line here." }),
      ),
    ).toBe("failed");
  });

  test("reads session id from the documented idle payload shape", () => {
    expect(eventType({ type: "session.idle", properties: { sessionID: "ses_x" } })).toBe("session.idle");
    expect(eventSessionID({ type: "session.idle", properties: { sessionID: "ses_x" } })).toBe("ses_x");
  });

  test("defaults to the OpenCode persona and voice key", () => {
    const resolved = loadOpenCodeVoiceConfig({}, undefined, "/tmp/echo-absent-home");
    expect(resolved.personaName).toBe("OpenCode");
    expect(resolved.voiceId).toBe("opencode");
    expect(resolved.greetOnSessionStart).toBe(false);
    expect(resolved.sayName).toBe(false);
  });

  test("messageFromAssistantText prefers a voice line over fallback", () => {
    expect(messageFromAssistantText("Long assistant prose.\n\n🗣️ OpenCode: Short spoken line.", "OpenCode"))
      .toBe("Short spoken line.");
    expect(extractFallbackSummary("The adapter now speaks the last assistant turn."))
      .toBe("The adapter now speaks the last assistant turn.");
  });

  test("lastAssistantTextFromMessages walks SDK message envelopes", () => {
    expect(lastAssistantTextFromMessages([
      { info: { role: "user" }, parts: [{ type: "text", text: "hi" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Done with the wiring." }] },
    ])).toBe("Done with the wiring.");
  });
});

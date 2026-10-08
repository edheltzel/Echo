import { afterEach, describe, expect, test } from "bun:test";
import {
  eventSessionID,
  eventType,
  extractFallbackSummary,
  handleOpenCodeEvent,
  lastAssistantFromMessages,
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

let sessionLookups = 0;

function port(opts: {
  parentID?: string;
  text?: string;
  messageID?: string;
  missing?: boolean;
} = {}): OpenCodeSessionPort {
  return {
    async getSession(id) {
      sessionLookups += 1;
      if (opts.missing) return null;
      return { id, parentID: opts.parentID };
    },
    async lastAssistant() {
      return { id: opts.messageID ?? "msg_1", text: opts.text ?? "" };
    },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetSpokenKeys();
  sessionLookups = 0;
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
        slot: "done",
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
    expect(bodies[0]).not.toHaveProperty("slot");
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

  test("a new turn whose text matches the previous turn still speaks", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const event = { type: "session.idle", sessionID: "ses_rep" };
    const text = "All 42 tests pass.\n\n🗣️ OpenCode: All tests pass.";
    expect(await handleOpenCodeEvent(event, config, port({ text, messageID: "msg_a" }))).toBe("sent");
    expect(await handleOpenCodeEvent(event, config, port({ text, messageID: "msg_b" }))).toBe("sent");
    expect(calls).toBe(2);
  });

  test("two idles for one turn delivered together speak once", async () => {
    // OpenCode publishes session.idle from both processor.halt and the runner on
    // an aborted or errored turn, and calls plugin hooks without awaiting them.
    // The first send is held open until the second event has made its decision,
    // so both events overlap exactly as two un-awaited hooks would.
    const firstSendStarted = Promise.withResolvers<void>();
    const releaseSend = Promise.withResolvers<void>();
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      firstSendStarted.resolve();
      if (calls >= 2) releaseSend.resolve(); // a second send means the race was lost; never hang
      await releaseSend.promise;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const event = { type: "session.idle", sessionID: "ses_abort" };
    const text = "🗣️ OpenCode: Stopped mid-refactor.";
    const first = handleOpenCodeEvent(event, config, port({ text }));
    await firstSendStarted.promise;
    const second = await handleOpenCodeEvent(event, config, port({ text }));
    releaseSend.resolve();
    expect([await first, second]).toEqual(["sent", "skipped"]);
    expect(calls).toBe(1);
  });

  test("a failed send does not block a retry of the same turn", async () => {
    globalThis.fetch = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const event = { type: "session.idle", sessionID: "ses_retry" };
    const lookup = port({ text: "🗣️ OpenCode: Retry me." });
    expect(await handleOpenCodeEvent(event, config, lookup)).toBe("failed");
    globalThis.fetch = (async () => new Response("{}", { status: 202 })) as unknown as typeof fetch;
    expect(await handleOpenCodeEvent(event, config, lookup)).toBe("sent");
  });

  test("an idle whose newest assistant message has no text stays silent", async () => {
    // A `!shell` turn or an abort during a tool call ends on an assistant message
    // with only tool parts; the previous turn's line must not be spoken again.
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 202 });
    }) as unknown as typeof fetch;
    const event = { type: "session.idle", sessionID: "ses_shell" };
    expect(await handleOpenCodeEvent(event, config, port({ text: "", messageID: "msg_tool" }))).toBe("skipped");
    expect(calls).toBe(0);
  });

  test("events other than session.created and session.idle never query the session", async () => {
    const lookup = port({ text: "🗣️ OpenCode: Unused." });
    for (const type of ["message.part.delta", "message.updated", "session.updated", "session.status"]) {
      expect(await handleOpenCodeEvent({ type, properties: { sessionID: "ses_busy" } }, config, lookup)).toBe("skipped");
    }
    expect(sessionLookups).toBe(0);
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

  test("lastAssistantFromMessages reads only the newest assistant message", () => {
    const user = { info: { role: "user", id: "msg_u" }, parts: [{ type: "text", text: "hi" }] };
    const textReply = { info: { role: "assistant", id: "msg_1" }, parts: [{ type: "text", text: "Done with the wiring." }] };
    const toolOnly = { info: { role: "assistant", id: "msg_2" }, parts: [{ type: "tool", tool: "bash" }] };
    expect(lastAssistantFromMessages([user, textReply])).toEqual({ id: "msg_1", text: "Done with the wiring." });
    expect(lastAssistantFromMessages([user, textReply, user, toolOnly])).toEqual({ id: "msg_2", text: "" });
    expect(lastAssistantFromMessages([user])).toEqual({ text: "" });
    expect(lastAssistantFromMessages(undefined)).toEqual({ text: "" });
  });
});

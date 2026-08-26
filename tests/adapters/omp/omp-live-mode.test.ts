import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import echoVoiceOmpAdapter from "../../../adapters/omp/index.ts";
import type { OmpVoiceConfig } from "../../../adapters/omp/config.ts";
import { ECHO_ASK_TOOL_NAME } from "../../../converse/host-tool.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

const originalFetch = globalThis.fetch;

const config: OmpVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "OMP Notification",
  startupCatchphrases: ["OMP online."],
  personaName: "OMP",
  sayName: false,
  voiceId: "omp",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
  suppressInSubagents: true,
};

function createMockOmp() {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Record<string, any>>();
  return {
    handlers,
    tools,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: () => {},
      registerTool: (definition: Record<string, any>) => tools.set(String(definition.name), definition),
    } as unknown as ExtensionAPI,
  };
}

function context(sessionId: string, ui: Record<string, unknown> = { notify: () => {} }) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/project",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
    },
    signal: undefined,
    ui,
  };
}

const liveDelegation = { message: { role: "custom", customType: "live-delegation", content: "Fix the test." } };

function completion(id: string, summary: string) {
  return { message: { role: "assistant", id, content: `Done.\n🗣️ OMP: ${summary}` } };
}

/** Collects every notify request and returns the session ids that reached the daemon. */
function captureRequests(): Array<{ url: string; body: Record<string, unknown> }> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 202 });
  };
  return requests;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  // Never leave a shifted clock behind: bun shares the process across test files.
  setSystemTime();
});

describe("omp live mode suppression", () => {
  test("tracks OMP live-delegation messages per session without muting the daemon", async () => {
    const requests = captureRequests();

    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const liveSession = context("session-live");
    const normalSession = context("session-normal");

    // OMP 18 emits this public custom-message shape for every live delegation.
    await handlers.get("message_start")?.(liveDelegation, liveSession);
    await handlers.get("message_end")?.(completion("live-1", "Fixed the test."), liveSession);
    expect(requests).toEqual([]);

    await handlers.get("message_end")?.(completion("normal-1", "Normal session finished."), normalSession);
    expect(requests.map((request) => request.body.session_id)).toEqual(["session-normal"]);

    // A normal user message is one supported transition back out of live delegation.
    await handlers.get("message_start")?.(
      { message: { role: "user", content: [{ type: "text", text: "Continue normally." }] } },
      liveSession,
    );
    await handlers.get("message_end")?.(completion("live-2", "Normal mode resumed."), liveSession);

    expect(requests.map((request) => request.body.session_id)).toEqual(["session-normal", "session-live"]);
    expect(requests.every((request) => new URL(request.url).pathname === "/notify")).toBe(true);
  });

  test("an agent-driven custom turn also leaves live mode", async () => {
    // omp has no live-end signal, and typed user messages are not the only way a turn starts:
    // prewalk, advisor and session-stop continuations all trigger turns with role "custom".
    // Releasing only on role "user" would keep those turns silent indefinitely.
    const requests = captureRequests();
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const session = context("session-live");

    await handlers.get("message_start")?.(liveDelegation, session);
    await handlers.get("message_end")?.(completion("live-1", "Delegation done."), session);
    expect(requests).toEqual([]);

    await handlers.get("message_start")?.(
      { message: { role: "custom", customType: "prewalk-plan", content: "Plan the next step." } },
      session,
    );
    await handlers.get("message_end")?.(completion("post-live-1", "Planned the next step."), session);

    expect(requests.map((request) => request.body.message)).toEqual(["Planned the next step."]);
  });

  test("an assistant message inside the delegation's own turn does not leave live mode", async () => {
    // The assistant reply to a live delegation arrives between the delegation message and the
    // next turn, so releasing on it would cancel suppression before it ever applied.
    const requests = captureRequests();
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const session = context("session-live");

    await handlers.get("message_start")?.(liveDelegation, session);
    await handlers.get("message_start")?.({ message: { role: "assistant", id: "live-1" } }, session);
    await handlers.get("message_end")?.(completion("live-1", "Still in the delegation."), session);

    expect(requests).toEqual([]);
  });

  test("suppression is capped, so a session that never sees another turn recovers", async () => {
    const requests = captureRequests();
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const session = context("session-live");

    setSystemTime(new Date("2026-08-24T12:00:00Z"));
    await handlers.get("message_start")?.(liveDelegation, session);
    await handlers.get("message_end")?.(completion("live-1", "Delegation done."), session);
    expect(requests).toEqual([]);

    // Still inside the cap: live mode holds.
    setSystemTime(new Date("2026-08-24T12:09:00Z"));
    await handlers.get("message_end")?.(completion("live-2", "Still live."), session);
    expect(requests).toEqual([]);

    // Past the cap with no releasing turn in sight: Echo speaks again rather than staying
    // silent forever.
    setSystemTime(new Date("2026-08-24T12:11:00Z"));
    await handlers.get("message_end")?.(completion("live-3", "Recovered after the cap."), session);
    expect(requests.map((request) => request.body.message)).toEqual(["Recovered after the cap."]);
  });

  test("live mode suppresses the notification only, never the voice-line instruction", async () => {
    // before_agent_start fires BEFORE the prompting message's message_start, so gating it on
    // live mode reads a stale flag and strips the 🗣️ contract from the first turn after live
    // ends - the turn that most needs to be spoken.
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const session = context("session-live");

    await handlers.get("message_start")?.(liveDelegation, session);
    const result = (await handlers.get("before_agent_start")?.({ systemPrompt: ["base"] }, session)) as
      | { systemPrompt: string[] }
      | undefined;

    expect(result?.systemPrompt?.[0]).toBe("base");
    expect(result?.systemPrompt?.[1]).toContain("🗣️ OMP:");
  });

  test("session shutdown forgets the mark so a reused session id is not born silent", async () => {
    const requests = captureRequests();
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const session = context("session-live");

    await handlers.get("message_start")?.(liveDelegation, session);
    await handlers.get("session_shutdown")?.({}, session);
    await handlers.get("message_end")?.(completion("next-1", "New session speaks."), session);

    expect(requests.map((request) => request.body.message)).toEqual(["New session speaks."]);
  });

  test("echo_ask is unavailable during live mode and never reaches consent or the microphone", async () => {
    // omp's live conversation already owns the microphone, and echo_ask is the one Echo path
    // that opens it in the host process. The refusal happens before consent, so the human is
    // not prompted for a grant Echo could not honor.
    const { handlers, tools, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const tool = tools.get(ECHO_ASK_TOOL_NAME)!;

    let prompts = 0;
    const session = context("session-live", {
      notify: () => {},
      confirm: async () => {
        prompts++;
        return true;
      },
    });

    await handlers.get("message_start")?.(liveDelegation, session);
    const result = await tool.execute("call-1", { question: "Ready?" }, undefined, undefined, session);

    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("ask_unavailable");
    expect(result.content[0].text).toContain("live mode");
    expect(prompts).toBe(0);
  });
});

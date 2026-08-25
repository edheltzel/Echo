import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import echoVoiceOmpAdapter from "../../../adapters/omp/index.ts";
import type { OmpVoiceConfig } from "../../../adapters/omp/config.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

const originalFetch = globalThis.fetch;

const config: OmpVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "OMP Notification",
  startupCatchphrases: ["OMP online."],
  personaName: "OMP",
  voiceId: "omp",
  voiceEnabled: true,
  greetOnSessionStart: false,
  speakCompletions: true,
  suppressInSubagents: true,
};

function createMockOmp() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: () => {},
      registerTool: () => {},
    } as unknown as ExtensionAPI,
  };
}

function context(sessionId: string) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/project",
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
    },
    signal: undefined,
    ui: { notify: () => {} },
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("omp live mode suppression", () => {
  test("tracks OMP live-delegation messages per session without muting the daemon", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 202 });
    };

    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const liveSession = context("session-live");
    const normalSession = context("session-normal");

    // OMP 18 emits this public custom-message shape for every live delegation.
    await handlers.get("message_start")?.(
      { message: { role: "custom", customType: "live-delegation", content: "Fix the test." } },
      liveSession,
    );
    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "live-1", content: "Done.\n🗣️ OMP: Fixed the test." } },
      liveSession,
    );
    expect(requests).toEqual([]);

    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "normal-1", content: "Done.\n🗣️ OMP: Normal session finished." } },
      normalSession,
    );
    expect(requests.map((request) => request.body.session_id)).toEqual(["session-normal"]);

    // A normal user message is the supported transition back out of live delegation.
    await handlers.get("message_start")?.(
      { message: { role: "user", content: [{ type: "text", text: "Continue normally." }] } },
      liveSession,
    );
    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "live-2", content: "Done.\n🗣️ OMP: Normal mode resumed." } },
      liveSession,
    );

    expect(requests.map((request) => request.body.session_id)).toEqual(["session-normal", "session-live"]);
    expect(requests.every((request) => new URL(request.url).pathname === "/notify")).toBe(true);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import echoVoiceOmpAdapter from "../../../adapters/omp/index.ts";
import type { OmpVoiceConfig } from "../../../adapters/omp/config.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;

const originalFetch = globalThis.fetch;
const originalPreferred = process.env.ECHO_PREFERRED_NAME;

const config: OmpVoiceConfig = {
  endpoint: "http://voice.example/notify",
  title: "OMP Notification",
  startupCatchphrases: ["OMP online."],
  personaName: "Atlas",
  sayName: false,
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

function context(sessionId = "session-1") {
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
  if (originalPreferred === undefined) delete process.env.ECHO_PREFERRED_NAME;
  else process.env.ECHO_PREFERRED_NAME = originalPreferred;
});

describe("omp HIL announce", () => {
  test("tool_approval_requested speaks once and live mode stays quiet", async () => {
    process.env.ECHO_PREFERRED_NAME = "Ed";
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 202 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, config);
    const approval = {
      type: "tool_approval_requested",
      toolCallId: "c1",
      toolName: "bash",
      reason: "Run the verification command?",
    };
    const ctx = context();
    await handlers.get("tool_approval_requested")?.(approval, ctx);
    await handlers.get("tool_approval_requested")?.(approval, ctx);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      message: "Ed, Atlas needs approval: Run the verification command?",
      source: "omp",
      session_id: "session-1",
      voice_id: "omp",
    });

    const live = context("session-live");
    await handlers.get("message_start")?.(
      { message: { role: "custom", customType: "live-delegation", content: "Fix the test." } },
      live,
    );
    await handlers.get("ui_prompt_start")?.(
      { type: "ui_prompt_start", kind: "custom", title: "Choose a deployment target." },
      live,
    );
    expect(payloads).toHaveLength(1);
  });
});

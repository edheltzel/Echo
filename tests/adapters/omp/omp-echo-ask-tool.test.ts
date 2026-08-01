import { describe, expect, test } from "bun:test";
import echoVoiceOmpAdapter from "../../../adapters/omp/index.ts";
import { loadOmpVoiceConfig } from "../../../adapters/omp/config.ts";
import { ECHO_ASK_PARAMETERS, ECHO_ASK_TOOL_NAME } from "../../../converse/host-tool.ts";

// omp's side of two-way voice. It registers the same shared tool as the Pi
// adapter rather than its own copy, which is the property asserted here: the
// registered definition is byte-identical in schema, so the two hosts cannot
// drift. Tool behavior lives in tests/converse/host-tool.
//
// No test here executes the tool: executing it would start a real turn.

function mockHost(options: { withToolApi?: boolean } = {}) {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, Record<string, any>>();
  const api: Record<string, unknown> = {
    extension: handlers,
    on(this: { extension: Map<string, unknown> }, event: string, handler: unknown) {
      this.extension.set(event, handler);
    },
    registerCommand: (name: string, opts: unknown) => commands.set(name, opts),
  };
  if (options.withToolApi !== false) {
    api.registerTool = function (this: { extension: Map<string, unknown> }, definition: Record<string, any>) {
      expect(this.extension).toBe(handlers);
      tools.set(String(definition.name), definition);
    };
  }
  return { handlers, commands, tools, api: api as unknown as Parameters<typeof echoVoiceOmpAdapter>[0] };
}

describe("omp adapter: echo_ask tool", () => {
  test("registers the shared ask tool", () => {
    const host = mockHost();

    echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}));

    const tool = host.tools.get(ECHO_ASK_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.parameters).toEqual(ECHO_ASK_PARAMETERS);
    expect(tool!.approval).toBe("read");
  });

  test("refuses without a live omp session consent grant", async () => {
    const host = mockHost();
    echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}));
    const tool = host.tools.get(ECHO_ASK_TOOL_NAME)!;

    const result = await tool.execute("call-1", { question: "Ready?" }, undefined, undefined, {});

    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("session_consent_required");
  });

  test("prompts at most once per omp session and expires the denial on shutdown", async () => {
    const host = mockHost();
    echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}));
    const tool = host.tools.get(ECHO_ASK_TOOL_NAME)!;
    const start = host.handlers.get("session_start") as (event: unknown, ctx: unknown) => Promise<void>;
    const shutdown = host.handlers.get("session_shutdown") as () => void;
    let sessionId = "session-a";
    let prompts = 0;
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      sessionManager: {
        getSessionFile: () => sessionId,
        getSessionId: () => sessionId,
      },
      ui: {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
    };

    await start({ reason: "reload" }, ctx);
    await tool.execute("call-1", { question: "Ready?" }, undefined, undefined, ctx);
    await tool.execute("call-2", { question: "Still ready?" }, undefined, undefined, ctx);
    expect(prompts).toBe(1);

    shutdown();
    sessionId = "session-b";
    await start({ reason: "reload" }, ctx);
    await tool.execute("call-3", { question: "Now ready?" }, undefined, undefined, ctx);
    expect(prompts).toBe(2);
  });

  test("a session without UI stays retryable instead of recording a sticky denial", async () => {
    const host = mockHost();
    echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}));
    const tool = host.tools.get(ECHO_ASK_TOOL_NAME)!;
    const start = host.handlers.get("session_start") as (event: unknown, ctx: unknown) => Promise<void>;
    let prompts = 0;
    const ctx = {
      cwd: "/repo",
      hasUI: false,
      sessionManager: {
        getSessionFile: () => "session-a",
        getSessionId: () => "session-a",
      },
      ui: {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
    } as { hasUI: boolean; [key: string]: unknown };

    await start({ reason: "reload" }, ctx);
    const headless = await tool.execute("call-1", { question: "Ready?" }, undefined, undefined, ctx);
    expect(headless.details.error).toBe("session_consent_required");
    expect(prompts).toBe(0);

    ctx.hasUI = true;
    const prompted = await tool.execute("call-2", { question: "Ready now?" }, undefined, undefined, ctx);
    expect(prompted.details.error).toBe("session_consent_denied");
    expect(prompts).toBe(1);
  });

  test("a cancellation before the consent prompt is presented stays retryable", async () => {
    const host = mockHost();
    echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}));
    const tool = host.tools.get(ECHO_ASK_TOOL_NAME)!;
    const start = host.handlers.get("session_start") as (event: unknown, ctx: unknown) => Promise<void>;
    let prompts = 0;
    const ctx = {
      cwd: "/repo",
      hasUI: true,
      sessionManager: {
        getSessionFile: () => "session-a",
        getSessionId: () => "session-a",
      },
      ui: {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
    };
    const aborted = new AbortController();
    aborted.abort();

    await start({ reason: "reload" }, ctx);
    const cancelled = await tool.execute("call-1", { question: "Ready?" }, aborted.signal, undefined, ctx);
    expect(cancelled.details.error).toBe("session_consent_required");
    expect(prompts).toBe(0);

    const prompted = await tool.execute("call-2", { question: "Ready now?" }, undefined, undefined, ctx);
    expect(prompted.details.error).toBe("session_consent_denied");
    expect(prompts).toBe(1);
  });

  test("a runtime without registerTool still gets the voice adapter", () => {
    const host = mockHost({ withToolApi: false });

    expect(() => echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}))).not.toThrow();

    expect(host.tools.size).toBe(0);
    expect(host.handlers.has("turn_end")).toBe(true);
  });

  test("the existing commands are still registered alongside the tool", () => {
    const host = mockHost();

    echoVoiceOmpAdapter(host.api, loadOmpVoiceConfig({}));

    expect([...host.commands.keys()].sort()).toEqual(["echo-voice", "voice-status"]);
  });
});

import { describe, expect, test } from "bun:test";
import atlasVoicePiAdapter from "../../../adapters/pi/index.ts";
import { loadPiVoiceConfig } from "../../../adapters/pi/config.ts";
import { ECHO_ASK_PARAMETERS, ECHO_ASK_TOOL_NAME } from "../../../converse/host-tool.ts";

// The Pi adapter's side of two-way voice: it registers the model-invokable
// echo_ask tool. The tool's behavior is covered in tests/converse/host-tool;
// what matters here is that this adapter registers it, that it survives a
// runtime without the tool API, and that the existing command surface is intact.
//
// No test here executes the tool: executing it would start a real turn.

interface Doubles {
  handlers: Map<string, unknown>;
  commands: Map<string, unknown>;
  tools: Map<string, Record<string, any>>;
  api: Parameters<typeof atlasVoicePiAdapter>[0];
}

function mockHost(options: { withToolApi?: boolean } = {}): Doubles {
  const handlers = new Map<string, unknown>();
  const commands = new Map<string, unknown>();
  const tools = new Map<string, Record<string, any>>();
  const api: Record<string, unknown> = {
    on: (event: string, handler: unknown) => handlers.set(event, handler),
    registerCommand: (name: string, opts: unknown) => commands.set(name, opts),
  };
  if (options.withToolApi !== false) {
    api.registerTool = (definition: Record<string, any>) => tools.set(String(definition.name), definition);
  }
  return { handlers, commands, tools, api: api as unknown as Parameters<typeof atlasVoicePiAdapter>[0] };
}

describe("Pi adapter: echo_ask tool", () => {
  test("registers the shared ask tool", () => {
    const host = mockHost();

    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));

    const tool = host.tools.get(ECHO_ASK_TOOL_NAME);
    expect(tool).toBeDefined();
    expect(tool!.parameters).toEqual(ECHO_ASK_PARAMETERS);
    expect(typeof tool!.execute).toBe("function");
  });

  test("refuses without a live Pi session consent grant", async () => {
    const host = mockHost();
    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));
    const tool = host.tools.get(ECHO_ASK_TOOL_NAME)!;

    const result = await tool.execute("call-1", { question: "Ready?" }, undefined, undefined, {});

    expect(result.isError).toBe(true);
    expect(result.details.error).toBe("session_consent_required");
  });

  test("prompts at most once per Pi session and expires the denial on shutdown", async () => {
    const host = mockHost();
    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));
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
    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));
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
    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));
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

    expect(() => atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}))).not.toThrow();

    expect(host.tools.size).toBe(0);
    // The notification path is the adapter's main job and must be unaffected.
    expect(host.handlers.has("message_end")).toBe(true);
    expect(host.commands.has("voice-status")).toBe(true);
  });

  test("the existing commands are still registered alongside the tool", () => {
    const host = mockHost();

    atlasVoicePiAdapter(host.api, loadPiVoiceConfig({}));

    expect([...host.commands.keys()].sort()).toEqual(["echo-mute", "echo-voice", "voice-status"]);
  });
});

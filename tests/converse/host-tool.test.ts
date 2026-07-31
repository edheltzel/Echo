import { describe, expect, test } from "bun:test";
import { AskError } from "../../converse/client.ts";
import {
  ECHO_ASK_PARAMETERS,
  ECHO_ASK_TOOL_NAME,
  registerEchoAskTool,
  runAskTool,
  type ToolRegisteringHost,
} from "../../converse/host-tool.ts";

// The tool both Pi and omp register. It lives in one module so the two hosts
// cannot drift into different tools, and the arg order below is the one the
// extension tool wrapper actually calls with: (toolCallId, params, signal,
// onUpdate, ctx). The file-based CustomTool API uses a different order.

type Registered = Record<string, any>;

function hostThatRegisters(): { host: ToolRegisteringHost; tools: Map<string, Registered> } {
  const tools = new Map<string, Registered>();
  return {
    tools,
    host: { registerTool: (definition) => void tools.set(String(definition.name), definition) },
  };
}

const askThatReturns = (text: string) => async () => ({
  text,
  turn_id: "t-1",
  engine: "yap" as const,
  capture_ms: 900,
  spoke: { notify_status: 202, drained: true, waited_ms: 1_000, polls: 1 },
  ancestry: ["900 bun", "800 wezterm-gui"],
});

describe("registering the ask tool", () => {
  test("registers echo_ask with a JSON Schema the Pi runtimes accept directly", () => {
    const { host, tools } = hostThatRegisters();

    expect(registerEchoAskTool(host, { source: "pi" })).toBe(true);

    const tool = tools.get(ECHO_ASK_TOOL_NAME)!;
    expect(tool.name).toBe("echo_ask");
    expect(tool.description).toContain("spoken answer");
    expect(tool.approval).toBe("read");
    // Plain JSON Schema: no schema library, so no host SDK import and no
    // dependency added to either adapter package.
    expect(tool.parameters).toEqual(ECHO_ASK_PARAMETERS);
    expect(ECHO_ASK_PARAMETERS.required).toEqual(["question"]);
  });

  test("a runtime without registerTool loses the tool, not the whole adapter", () => {
    // An older host must keep speaking notifications; throwing here would take
    // the extension down with it.
    expect(registerEchoAskTool({}, { source: "pi" })).toBe(false);
  });

  test("execute speaks the question and returns the transcript to the model", async () => {
    const { host, tools } = hostThatRegisters();
    registerEchoAskTool(host, { source: "pi", ask: askThatReturns("ship it on Friday") });

    const result = await tools.get(ECHO_ASK_TOOL_NAME)!.execute(
      "call-1",
      { question: "When should I ship?" },
      undefined,
      undefined,
      {},
    );

    expect(result.content).toEqual([{ type: "text", text: "ship it on Friday" }]);
    expect(result.isError).toBe(false);
    expect(result.details.engine).toBe("yap");
    expect(result.details.ancestry).toContain("800 wezterm-gui");
  });

  test("the host tag reaches the turn, so both daemons record which host asked", async () => {
    const { host, tools } = hostThatRegisters();
    let source = "";
    registerEchoAskTool(host, {
      source: "omp",
      ask: async (options) => {
        source = options.source ?? "";
        return (await askThatReturns("ok")())!;
      },
    });

    await tools.get(ECHO_ASK_TOOL_NAME)!.execute("call-1", { question: "Ready?" }, undefined, undefined, {});

    expect(source).toBe("omp");
  });

  test("the per-call voice is resolved from the host context, not frozen at registration", async () => {
    const { host, tools } = hostThatRegisters();
    const seen: unknown[] = [];
    registerEchoAskTool(host, {
      source: "omp",
      resolveVoice: (ctx) => {
        seen.push(ctx);
        return { voiceId: "pi", title: "Echo" };
      },
      ask: askThatReturns("yes"),
    });

    await tools.get(ECHO_ASK_TOOL_NAME)!.execute("call-1", { question: "Ready?" }, undefined, undefined, { cwd: "/repo" });

    expect(seen).toEqual([{ cwd: "/repo" }]);
  });

  test("the abort signal reaches the turn from the tool call", async () => {
    const { host, tools } = hostThatRegisters();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    registerEchoAskTool(host, {
      source: "pi",
      ask: async (options) => {
        received = options.signal;
        return (await askThatReturns("ok")())!;
      },
    });

    await tools.get(ECHO_ASK_TOOL_NAME)!.execute("call-1", { question: "Ready?" }, controller.signal, undefined, {});

    expect(received).toBe(controller.signal);
  });
});

describe("tool outcomes", () => {
  test("a failed turn is tool text, not a thrown host error", async () => {
    const outcome = await runAskTool({ question: "Ready?" }, {
      source: "pi",
      ask: async () => {
        throw new AskError("no_speech", "the recording contained no speech");
      },
    });

    expect(outcome.isError).toBe(true);
    expect(outcome.text).toContain("no_speech");
    expect(outcome.details.error).toBe("no_speech");
  });

  test("a busy microphone tells the model to try again rather than failing silently", async () => {
    const outcome = await runAskTool({ question: "Ready?" }, {
      source: "pi",
      ask: async () => {
        throw new AskError("microphone_busy", "another turn holds the microphone");
      },
    });

    expect(outcome.text).toContain("microphone_busy");
    expect(outcome.isError).toBe(true);
  });

  test.each([[{}], [{ question: "" }], [{ question: 42 }], [null]])(
    "a malformed call (%p) is reported without starting a turn",
    async (params) => {
      let asked = 0;
      const outcome = await runAskTool(params, {
        source: "pi",
        ask: async () => {
          asked++;
          return (await askThatReturns("never")())!;
        },
      });

      expect(outcome.isError).toBe(true);
      expect(asked).toBe(0);
    },
  );

  test("the question is trimmed before it is spoken", async () => {
    let spoken = "";
    await runAskTool({ question: "  Ready to ship?  " }, {
      source: "pi",
      ask: async (options) => {
        spoken = options.question;
        return (await askThatReturns("yes")())!;
      },
    });

    expect(spoken).toBe("Ready to ship?");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import atlasVoicePiAdapter from "../../../adapters/pi/index";

type Handler = (event: unknown, ctx: any) => Promise<void> | void;

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const originalDateNow = Date.now;

function createMockPi() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: {
      on: (event: string, handler: Handler) => handlers.set(event, handler),
      registerCommand: () => {},
    },
  };
}

function createContext(sessionId = "session-1", overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui",
    hasUI: true,
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => sessionId,
    },
    signal: undefined,
    ui: { notify: () => {} },
    ...overrides,
  };
}

function assistantEvent(id: string, line = "Tests passed.") {
  return {
    message: {
      role: "assistant",
      id,
      content: `Summary\n🗣️ ${line}`,
    },
  };
}

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.ATLAS_VOICE_SUPPRESS;
  process.env.ATLAS_VOICE_NOTIFY_URL = "http://voice.example/notify";
  process.env.ATLAS_VOICE_CATCHPHRASE = "Pi session ready.";
  Date.now = originalDateNow;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  Date.now = originalDateNow;
});

describe("Pi adapter lifecycle", () => {
  test("session_start sends one configured greeting", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    await handlers.get("session_start")?.({ reason: "startup" }, createContext());

    expect(payloads).toEqual([
      {
        message: "Pi session ready.",
        title: "Pi Notification",
        voice_enabled: true,
        session_id: "session-1",
        source: "pi",
      },
    ]);
  });

  test("message_end and turn_end for the same message speak once", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const event = assistantEvent("m1");
    const ctx = createContext();

    await handlers.get("message_end")?.(event, ctx);
    await handlers.get("turn_end")?.(event, ctx);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ message: "Tests passed.", source: "pi", session_id: "session-1" });
  });

  test("failed notify does not poison dedupe retry", async () => {
    const statuses = [503, 200];
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: statuses.shift() ?? 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const event = assistantEvent("m1");
    const ctx = createContext();

    await handlers.get("message_end")?.(event, ctx);
    await handlers.get("turn_end")?.(event, ctx);

    expect(payloads).toHaveLength(2);
  });

  test("headless subagent context speaks nothing", async () => {
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    // Pi spawns subagents as `pi --mode json -p`: headless, hasUI === false.
    const ctx = createContext("session-1", { mode: "json", hasUI: false });

    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    await handlers.get("message_end")?.(assistantEvent("m1"), ctx);
    await handlers.get("turn_end")?.(assistantEvent("m1"), ctx);

    expect(payloads).toHaveLength(0);
  });

  test("before_agent_start appends the voice-line instruction to the system prompt", async () => {
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    const result = (await handlers.get("before_agent_start")?.(
      { prompt: "do a thing", systemPrompt: "BASE" },
      createContext(),
    )) as { systemPrompt?: string; systemPromptAppend?: string } | undefined;

    expect(result?.systemPrompt?.startsWith("BASE")).toBe(true);
    expect(result?.systemPrompt).toContain("🗣️ Atlas:");
    // Never clobbers: the base prompt survives ahead of the appended instruction.
    expect(result?.systemPrompt!.indexOf("BASE")).toBeLessThan(result!.systemPrompt!.indexOf("🗣️ Atlas:"));
    // Fallback append form is also offered for runtimes that ignore the replace return.
    expect(result?.systemPromptAppend).toContain("🗣️ Atlas:");
  });

  test("before_agent_start uses the configured persona name", async () => {
    process.env.ATLAS_VOICE_PERSONA_NAME = "Themis";
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    const result = (await handlers.get("before_agent_start")?.(
      { prompt: "x", systemPrompt: "BASE" },
      createContext(),
    )) as { systemPrompt?: string } | undefined;

    expect(result?.systemPrompt).toContain("🗣️ Themis:");
    expect(result?.systemPrompt).not.toContain("🗣️ Atlas:");
  });

  test("before_agent_start does not inject in a suppressed headless subagent", async () => {
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const ctx = createContext("session-1", { mode: "json", hasUI: false });

    const result = await handlers.get("before_agent_start")?.(
      { prompt: "x", systemPrompt: "BASE" },
      ctx,
    );

    expect(result).toBeUndefined();
  });

  test("before_agent_start does not inject when completions are disabled", async () => {
    process.env.ATLAS_VOICE_SPEAK_COMPLETIONS = "off";
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    const result = await handlers.get("before_agent_start")?.(
      { prompt: "x", systemPrompt: "BASE" },
      createContext(),
    );

    expect(result).toBeUndefined();
  });

  test("before_agent_start is a safe no-op when the runtime exposes no systemPrompt", async () => {
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    // Older runtime: event lacks `systemPrompt`. Must not throw, must not inject.
    const result = await handlers.get("before_agent_start")?.({ prompt: "x" }, createContext());

    expect(result).toBeUndefined();
  });

  test("dedupe expires so repeated legitimate later turns can speak", async () => {
    let now = 1_000;
    Date.now = () => now;
    const payloads: unknown[] = [];
    globalThis.fetch = async (_input, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };

    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);
    const event = assistantEvent("m1");
    const ctx = createContext();

    await handlers.get("message_end")?.(event, ctx);
    await handlers.get("turn_end")?.(event, ctx);
    now += 5_001;
    await handlers.get("message_end")?.(event, ctx);

    expect(payloads).toHaveLength(2);
  });
});

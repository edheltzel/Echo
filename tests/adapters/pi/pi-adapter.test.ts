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
  delete process.env.ECHO_VOICE_SUPPRESS;
  delete process.env.ATLAS_VOICE_SUPPRESS;
  process.env.ECHO_NOTIFY_URL = "http://voice.example/notify";
  process.env.ECHO_VOICE_CATCHPHRASE = "Pi session ready.";
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
        voice_id: "pi",
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
    expect(result?.systemPrompt).toContain("🗣️ Pi:");
    // Never clobbers: the base prompt survives ahead of the appended instruction.
    expect(result?.systemPrompt!.indexOf("BASE")).toBeLessThan(result!.systemPrompt!.indexOf("🗣️ Pi:"));
    // Fallback append form is also offered for runtimes that ignore the replace return.
    expect(result?.systemPromptAppend).toContain("🗣️ Pi:");
  });

  test("before_agent_start uses the configured persona name", async () => {
    process.env.ECHO_VOICE_PERSONA_NAME = "Themis";
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
    process.env.ECHO_VOICE_SPEAK_COMPLETIONS = "off";
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    const result = await handlers.get("before_agent_start")?.(
      { prompt: "x", systemPrompt: "BASE" },
      createContext(),
    );

    expect(result).toBeUndefined();
  });

  test("before_agent_start appends to an array system prompt (oh-my-pi shape)", async () => {
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    // oh-my-pi passes systemPrompt as string[] and expects string[] back.
    const result = (await handlers.get("before_agent_start")?.(
      { prompt: "do a thing", systemPrompt: ["BASE-1", "BASE-2"] },
      createContext(),
    )) as { systemPrompt?: string[] } | undefined;

    expect(Array.isArray(result?.systemPrompt)).toBe(true);
    expect(result?.systemPrompt?.slice(0, 2)).toEqual(["BASE-1", "BASE-2"]);
    expect(result?.systemPrompt?.[2]).toContain("🗣️ Pi:");
  });

  test("before_agent_start injects into an empty array system prompt", async () => {
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    // omp with an empty assembled prompt is legitimate — the instruction still lands.
    const result = (await handlers.get("before_agent_start")?.(
      { prompt: "x", systemPrompt: [] },
      createContext(),
    )) as { systemPrompt?: string[] } | undefined;

    expect(result?.systemPrompt).toHaveLength(1);
    expect(result?.systemPrompt?.[0]).toContain("🗣️ Pi:");
  });

  test("before_agent_start is a safe no-op for an unknown systemPrompt shape", async () => {
    const { api, handlers } = createMockPi();
    atlasVoicePiAdapter(api as any);

    const result = await handlers.get("before_agent_start")?.(
      { prompt: "x", systemPrompt: [{ role: "system", content: "BASE" }] },
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

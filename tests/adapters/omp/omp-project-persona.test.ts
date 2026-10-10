import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import echoVoiceOmpAdapter from "../../../adapters/omp/index";
import {
  applyPersonaOverride,
  loadOmpVoiceConfig,
  loadProjectPersona,
  type OmpVoiceConfig,
} from "../../../adapters/omp/config";

// omp project persona override: a `daidentity` block in the host's native YAML,
// project over global, project wins per key for name and voice. Startup speech
// is the fixed harness line.

const GLOBAL_PATH = (home: string) => join(home, ".omp", "agent", "config.yml");
const PROJECT_PATH = (cwd: string) => join(cwd, ".omp", "config.yml");

describe("loadProjectPersona - daidentity from omp YAML config layering", () => {
  const HOME = "/home/u";
  const CWD = "/proj";
  const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;

  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  beforeEach(() => { delete process.env.PI_CODING_AGENT_DIR; });
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  });

  test("no files → null", () => {
    expect(loadProjectPersona(CWD, () => null, HOME)).toBeNull();
  });

  test("project daidentity (YAML) → name + voice; leftover greeting keys are ignored", () => {
    const o = loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: [
        "theme: dark",
        "daidentity:",
        "  name: Libby",
        "  voices:",
        "    main:",
        "      voiceId: en-GB-LibbyNeural",
        "  startupCatchphrases:",
        "    - Libby here.",
        "    - Libby online.",
        "  sayName: true",
      ].join("\n"),
    }), HOME);
    expect(o).toEqual({
      personaName: "Libby",
      voiceId: "en-GB-LibbyNeural",
    });
  });

  test("global-only daidentity applies when no project file", () => {
    const o = loadProjectPersona(CWD, reader({
      [GLOBAL_PATH(HOME)]: "daidentity:\n  name: GlobalOmp\n  voiceId: en-US-AvaNeural\n",
    }), HOME);
    expect(o).toEqual({ personaName: "GlobalOmp", voiceId: "en-US-AvaNeural" });
  });

  test("project OVERRIDES global per key; unset project keys fall through", () => {
    const o = loadProjectPersona(CWD, reader({
      [GLOBAL_PATH(HOME)]: [
        "daidentity:",
        "  name: GlobalOmp",
        "  voices: { main: { voiceId: global-voice } }",
        "  startupCatchphrases: [Global line.]",
      ].join("\n"),
      [PROJECT_PATH(CWD)]: "daidentity:\n  voices:\n    main:\n      voiceId: en-GB-LibbyNeural\n",
    }), HOME);
    expect(o).toEqual({
      personaName: "GlobalOmp",
      voiceId: "en-GB-LibbyNeural",
    });
  });

  test("malformed YAML → null (never throws)", () => {
    expect(loadProjectPersona(CWD, reader({ [PROJECT_PATH(CWD)]: "daidentity:\n  name: [unterminated" }), HOME)).toBeNull();
  });

  test("config without a daidentity block → null", () => {
    const o = loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: "theme: dark\ndefaultThinkingLevel: auto\n",
    }), HOME);
    expect(o).toBeNull();
  });
});

describe("applyPersonaOverride - per-key override onto the base config", () => {
  const base: OmpVoiceConfig = {
    endpoint: "http://x/notify",
    title: "omp Notification",
    personaName: "omp",
    voiceId: "pi",
    voiceEnabled: true,
    greetOnSessionStart: true,
    speakCompletions: true,
    suppressInSubagents: true,
  };

  test("null override → base unchanged (same reference)", () => {
    expect(applyPersonaOverride(base, null)).toBe(base);
  });

  test("name + voice override leaves the other config fields", () => {
    const out = applyPersonaOverride(base, { personaName: "Libby", voiceId: "en-GB-LibbyNeural" });
    expect(out.personaName).toBe("Libby");
    expect(out.voiceId).toBe("en-GB-LibbyNeural");
    expect(out.speakCompletions).toBe(true);
    expect(out.greetOnSessionStart).toBe(true);
  });
});

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function createMockOmp() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: { on: (e: string, h: Handler) => handlers.set(e, h), registerCommand: () => {} } as unknown as ExtensionAPI,
  };
}

function ctxWithCwd(cwd: string, agent?: { parentId?: string; depth?: number; name?: string }) {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
    agent,
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "session-1" },
    signal: undefined,
    ui: { notify: () => {} },
  };
}

let projectDir: string;
let fakeHome: string;

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.ECHO_NOTIFY_URL = "http://voice.example/notify";
  process.env.ECHO_VOICE_PERSONA_NAME = "Atlas";
  process.env.ECHO_VOICE_ID = "pi";
  process.env.ECHO_VOICE_CATCHPHRASE = "Atlas online.";
  process.env.ECHO_VOICE_SAY_NAME = "true";
  fakeHome = mkdtempSync(join(tmpdir(), "echo-omp-home-"));
  mkdirSync(join(fakeHome, ".omp", "agent"), { recursive: true });
  process.env.PI_CODING_AGENT_DIR = join(fakeHome, ".omp", "agent");
  projectDir = mkdtempSync(join(tmpdir(), "echo-omp-int-"));
  mkdirSync(join(projectDir, ".omp"), { recursive: true });
  writeFileSync(
    join(projectDir, ".omp", "config.yml"),
    [
      "daidentity:",
      "  name: Libby",
      "  voices:",
      "    main:",
      "      voiceId: en-GB-LibbyNeural",
      "  startupCatchphrases:",
      "    - Libby here, omp British voice.",
      "  sayName: true",
    ].join("\n"),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("integration - omp project override flows through greeting + completion", () => {
  test("global config read is isolated (empty scratch agent dir → no override)", () => {
    expect(loadProjectPersona(undefined)).toBeNull();
  });

  test("startup says the harness line in the project voice; source=omp", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));

    await handlers.get("session_start")?.({}, ctxWithCwd(projectDir));

    expect(payloads).toHaveLength(1);
    expect(payloads[0].message).toBe("Oh em pee, ready.");
    expect(payloads[0].voice_id).toBe("en-GB-LibbyNeural");
    expect(payloads[0].source).toBe("omp");
  });

  test("explicit resume stays silent; a child agent stays silent", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));

    await handlers.get("session_start")?.({ reason: "resume" }, ctxWithCwd(projectDir));
    await handlers.get("session_start")?.({}, ctxWithCwd(projectDir, { parentId: "parent", depth: 1, name: "task" }));
    expect(payloads).toHaveLength(0);
  });

  test("ECHO_VOICE_GREET_ON_START=false stays silent", async () => {
    process.env.ECHO_VOICE_GREET_ON_START = "false";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));
    await handlers.get("session_start")?.({}, ctxWithCwd(projectDir));
    expect(calls).toBe(0);
  });

  test("per-turn completion uses the project voice", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));

    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "m1", content: "Did the thing.\n🗣️ Libby: Shipped the fix." } },
      ctxWithCwd(projectDir),
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0].voice_id).toBe("en-GB-LibbyNeural");
    expect(payloads[0].source).toBe("omp");
    expect(payloads[0].message).toBe("Shipped the fix.");
  });

  test("project with no daidentity → base voice", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const bare = mkdtempSync(join(tmpdir(), "echo-omp-bare-"));
    try {
      const { handlers, api } = createMockOmp();
      echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));
      await handlers.get("session_start")?.({}, ctxWithCwd(bare));
      expect(payloads[0].voice_id).toBe("pi");
      expect(payloads[0].message).toBe("Oh em pee, ready.");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

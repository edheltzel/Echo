import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atlasVoicePiAdapter from "../../../adapters/pi/index";
import {
  applyPersonaOverride,
  loadPiVoiceConfig,
  loadProjectPersona,
  type PiVoiceConfig,
} from "../../../adapters/pi/config";

// Pi project persona override: a `daidentity` block in the host's native
// settings.json, layered project over global. Project wins per key for name
// and voice. Startup speech is the fixed harness line, not the persona name.

const GLOBAL_PATH = (home: string) => join(home, ".pi", "agent", "settings.json");
const PROJECT_PATH = (cwd: string) => join(cwd, ".pi", "settings.json");

describe("loadProjectPersona - daidentity from .pi/settings.json layering", () => {
  const HOME = "/home/u";
  const CWD = "/proj";
  const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;
  const daidentity = (d: unknown) => JSON.stringify({ daidentity: d });

  test("no files → null", () => {
    expect(loadProjectPersona(CWD, () => null, HOME)).toBeNull();
  });

  test("project daidentity → name + voice; leftover greeting keys are ignored", () => {
    const o = loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: daidentity({
        name: "Echo",
        voices: { main: { voiceId: "en-US-AndrewNeural" } },
        startupCatchphrases: ["Echo online.", "Echo here."],
        sayName: true,
      }),
    }), HOME);
    expect(o).toEqual({
      personaName: "Echo",
      voiceId: "en-US-AndrewNeural",
    });
  });

  test("global-only daidentity applies when no project file", () => {
    const o = loadProjectPersona(CWD, reader({
      [GLOBAL_PATH(HOME)]: daidentity({ name: "GlobalPi", voices: { main: { voiceId: "en-GB-RyanNeural" } } }),
    }), HOME);
    expect(o).toEqual({ personaName: "GlobalPi", voiceId: "en-GB-RyanNeural" });
  });

  test("project OVERRIDES global per key; unset project keys fall through to global", () => {
    const o = loadProjectPersona(CWD, reader({
      [GLOBAL_PATH(HOME)]: daidentity({
        name: "GlobalPi",
        voices: { main: { voiceId: "global-voice" } },
        startupCatchphrases: ["Global line."],
      }),
      [PROJECT_PATH(CWD)]: daidentity({ voices: { main: { voiceId: "en-US-AndrewNeural" } } }),
    }), HOME);
    expect(o).toEqual({
      personaName: "GlobalPi",
      voiceId: "en-US-AndrewNeural",
    });
  });

  test("flat voiceId (no voices.main) also accepted", () => {
    const o = loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: daidentity({ name: "Echo", voiceId: "en-AU-WilliamNeural" }),
    }), HOME);
    expect(o?.voiceId).toBe("en-AU-WilliamNeural");
  });

  test("malformed settings.json → null (never throws)", () => {
    expect(loadProjectPersona(CWD, reader({ [PROJECT_PATH(CWD)]: "{ not json " }), HOME)).toBeNull();
  });

  test("settings.json without a daidentity block → null", () => {
    const o = loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: JSON.stringify({ theme: "dark", defaultProvider: "anthropic" }),
    }), HOME);
    expect(o).toBeNull();
  });

  test("greeting-only daidentity does not invent a persona override", () => {
    expect(loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: daidentity({ startupCatchphrases: ["Echo online."], sayName: true }),
    }), HOME)).toBeNull();
  });

  test("no cwd → still reads global settings.json", () => {
    const o = loadProjectPersona(undefined, reader({
      [GLOBAL_PATH(HOME)]: daidentity({ name: "GlobalPi" }),
    }), HOME);
    expect(o).toEqual({ personaName: "GlobalPi" });
  });
});

describe("applyPersonaOverride - per-key override onto the base config", () => {
  const base: PiVoiceConfig = {
    endpoint: "http://x/notify",
    title: "Pi Notification",
    personaName: "Pi",
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
    const out = applyPersonaOverride(base, { personaName: "Echo", voiceId: "en-US-AndrewNeural" });
    expect(out.personaName).toBe("Echo");
    expect(out.voiceId).toBe("en-US-AndrewNeural");
    expect(out.speakCompletions).toBe(true);
    expect(out.greetOnSessionStart).toBe(true);
  });
});

type Handler = (event: unknown, ctx: unknown) => Promise<void> | void;
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function createMockPi() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    api: { on: (e: string, h: Handler) => handlers.set(e, h), registerCommand: () => {} } as unknown as ExtensionAPI,
  };
}

function ctxWithCwd(cwd: string) {
  return {
    mode: "tui",
    hasUI: true,
    cwd,
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
  process.env.ECHO_VOICE_CATCHPHRASE = "Atlas online and standing by.";
  process.env.ECHO_VOICE_SAY_NAME = "true";
  fakeHome = mkdtempSync(join(tmpdir(), "echo-pi-home-"));
  process.env.HOME = fakeHome;
  projectDir = mkdtempSync(join(tmpdir(), "echo-pi-int-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "settings.json"),
    JSON.stringify({
      daidentity: {
        name: "Echo",
        voices: { main: { voiceId: "en-US-AndrewNeural" } },
        startupCatchphrases: ["Echo online."],
        sayName: true,
      },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("integration - project override flows through greeting + completion", () => {
  test("startup says the harness line in the project voice, ignoring persona and legacy greeting settings", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockPi();
    atlasVoicePiAdapter(api, loadPiVoiceConfig(process.env));

    await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(projectDir));

    expect(payloads).toHaveLength(1);
    expect(payloads[0].message).toBe("Pie, ready.");
    expect(payloads[0].voice_id).toBe("en-US-AndrewNeural");
  });

  test("per-turn completion uses the project voice and persona name", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockPi();
    atlasVoicePiAdapter(api, loadPiVoiceConfig(process.env));

    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "m1", content: "Did the thing.\n🗣️ Echo: Shipped the fix." } },
      ctxWithCwd(projectDir),
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0].voice_id).toBe("en-US-AndrewNeural");
    expect(payloads[0].message).toBe("Shipped the fix.");
  });

  test("project with no daidentity → base voice", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const bare = mkdtempSync(join(tmpdir(), "echo-pi-bare-"));
    try {
      const { handlers, api } = createMockPi();
      atlasVoicePiAdapter(api, loadPiVoiceConfig(process.env));
      await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(bare));
      expect(payloads[0].voice_id).toBe("pi");
      expect(payloads[0].message).toBe("Pie, ready.");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

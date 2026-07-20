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

// Pi project persona override — SAME convention as the Claude Code adapter: a
// `daidentity` block in the host's native settings.json, layered project over
// global. Pi's own layering is `<cwd>/.pi/settings.json` (project) over
// `~/.pi/agent/settings.json` (global), project wins per key. Inside a repo with
// a project daidentity, the greeting + per-turn voice use that persona.

const GLOBAL_PATH = (home: string) => join(home, ".pi", "agent", "settings.json");
const PROJECT_PATH = (cwd: string) => join(cwd, ".pi", "settings.json");

// ── config-level unit tests (pure; injected readFile + explicit home) ────────
describe("loadProjectPersona — daidentity from .pi/settings.json layering", () => {
  const HOME = "/home/u";
  const CWD = "/proj";
  const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;
  const daidentity = (d: unknown) => JSON.stringify({ daidentity: d });

  test("no files → null", () => {
    expect(loadProjectPersona(CWD, () => null, HOME)).toBeNull();
  });

  test("project daidentity → name + voice + catchphrases", () => {
    const o = loadProjectPersona(CWD, reader({
      [PROJECT_PATH(CWD)]: daidentity({
        name: "Echo",
        voices: { main: { voiceId: "en-US-AndrewNeural" } },
        startupCatchphrases: ["Echo online.", "Echo here."],
      }),
    }), HOME);
    expect(o).toEqual({
      personaName: "Echo",
      voiceId: "en-US-AndrewNeural",
      startupCatchphrases: ["Echo online.", "Echo here."],
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
      // Project sets only the voice → name + catchphrases fall through to global.
      [PROJECT_PATH(CWD)]: daidentity({ voices: { main: { voiceId: "en-US-AndrewNeural" } } }),
    }), HOME);
    expect(o).toEqual({
      personaName: "GlobalPi",              // from global
      voiceId: "en-US-AndrewNeural",         // project wins
      startupCatchphrases: ["Global line."], // from global
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

  test("no cwd → still reads global settings.json", () => {
    const o = loadProjectPersona(undefined, reader({
      [GLOBAL_PATH(HOME)]: daidentity({ name: "GlobalPi" }),
    }), HOME);
    expect(o).toEqual({ personaName: "GlobalPi" });
  });
});

describe("applyPersonaOverride — per-key override onto the base config", () => {
  const base: PiVoiceConfig = {
    endpoint: "http://x/notify",
    title: "Pi Notification",
    startupCatchphrases: ["Base ready."],
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

  test("name + voice override; non-persona keys untouched", () => {
    const out = applyPersonaOverride(base, { personaName: "Echo", voiceId: "en-US-AndrewNeural" });
    expect(out.personaName).toBe("Echo");
    expect(out.voiceId).toBe("en-US-AndrewNeural");
    expect(out.startupCatchphrases).toEqual(["Base ready."]);
    expect(out.speakCompletions).toBe(true);
  });
});

// ── integration: greeting + completion use the override via ctx.cwd ──────────
// HOME is redirected to a temp dir (no global ~/.pi/agent/settings.json daidentity)
// so the test is isolated from the real user config; only the project file counts.
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
  process.env.ECHO_VOICE_PERSONA_NAME = "Pi";
  process.env.ECHO_VOICE_ID = "pi";
  fakeHome = mkdtempSync(join(tmpdir(), "echo-pi-home-"));
  process.env.HOME = fakeHome; // homedir() → fakeHome (no global daidentity there)
  projectDir = mkdtempSync(join(tmpdir(), "echo-pi-int-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "settings.json"),
    JSON.stringify({
      daidentity: { name: "Echo", voices: { main: { voiceId: "en-US-AndrewNeural" } }, startupCatchphrases: ["Echo online."] },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("integration — project override flows through greeting + completion", () => {
  test("session_start greeting uses the project catchphrase AND voice", async () => {
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockPi();
    atlasVoicePiAdapter(api, loadPiVoiceConfig(process.env)); // base persona=Pi, voice=pi

    await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(projectDir));

    expect(payloads).toHaveLength(1);
    expect(payloads[0].message).toBe("Echo online.");        // project catchphrase
    expect(payloads[0].voice_id).toBe("en-US-AndrewNeural");  // project voice, not "pi"
  });

  test("per-turn completion uses the project voice", async () => {
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockPi();
    atlasVoicePiAdapter(api, loadPiVoiceConfig(process.env));

    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "m1", content: "Did the thing.\n🗣️ Shipped the fix." } },
      ctxWithCwd(projectDir),
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0].voice_id).toBe("en-US-AndrewNeural");
  });

  test("project with no daidentity → base persona/voice (global stands)", async () => {
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const bare = mkdtempSync(join(tmpdir(), "echo-pi-bare-"));
    try {
      const { handlers, api } = createMockPi();
      atlasVoicePiAdapter(api, loadPiVoiceConfig(process.env));
      await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(bare));
      expect(payloads[0].voice_id).toBe("pi"); // base voice, no override
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

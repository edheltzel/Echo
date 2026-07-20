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

// Pi project persona override: a repo drops <cwd>/.pi/echo-voice.json (daidentity
// shape) and — inside that repo only — the greeting + per-turn voice use the
// project persona name + voice. Layered over the env-based global config, resolved
// from ctx.cwd. Mirrors the Claude Code adapter's project override for Pi.

// ── config-level unit tests (pure; injectable readFile) ──────────────────────
describe("loadProjectPersona — reads <cwd>/.pi/echo-voice.json", () => {
  const reader = (contents: Record<string, string>) => (path: string) => contents[path] ?? null;

  test("no cwd → null (no FS access)", () => {
    expect(loadProjectPersona(undefined, () => "should not be read")).toBeNull();
    expect(loadProjectPersona("", () => "should not be read")).toBeNull();
  });

  test("wrapped daidentity block → name + voice + catchphrases", () => {
    const path = join("/proj", ".pi", "echo-voice.json");
    const o = loadProjectPersona("/proj", reader({
      [path]: JSON.stringify({
        daidentity: {
          name: "Echo",
          voices: { main: { voiceId: "en-US-AndrewNeural" } },
          startupCatchphrases: ["Echo online.", "Echo here."],
        },
      }),
    }));
    expect(o).toEqual({
      personaName: "Echo",
      voiceId: "en-US-AndrewNeural",
      startupCatchphrases: ["Echo online.", "Echo here."],
    });
  });

  test("unwrapped fields (no daidentity wrapper) also accepted", () => {
    const path = join("/proj", ".pi", "echo-voice.json");
    const o = loadProjectPersona("/proj", reader({
      [path]: JSON.stringify({ name: "Echo", voices: { main: { voiceId: "en-GB-RyanNeural" } } }),
    }));
    expect(o).toEqual({ personaName: "Echo", voiceId: "en-GB-RyanNeural" });
  });

  test("partial override (name only) → only that key set", () => {
    const path = join("/proj", ".pi", "echo-voice.json");
    const o = loadProjectPersona("/proj", reader({ [path]: JSON.stringify({ daidentity: { name: "Echo" } }) }));
    expect(o).toEqual({ personaName: "Echo" });
  });

  test("missing file → null", () => {
    expect(loadProjectPersona("/proj", () => null)).toBeNull();
  });

  test("malformed JSON → null (never throws)", () => {
    const path = join("/proj", ".pi", "echo-voice.json");
    expect(loadProjectPersona("/proj", reader({ [path]: "{ not json " }))).toBeNull();
  });

  test("empty override object → null", () => {
    const path = join("/proj", ".pi", "echo-voice.json");
    expect(loadProjectPersona("/proj", reader({ [path]: JSON.stringify({ daidentity: {} }) }))).toBeNull();
  });

  test("reads the real file from disk when no reader injected", () => {
    const dir = mkdtempSync(join(tmpdir(), "echo-pi-proj-"));
    try {
      mkdirSync(join(dir, ".pi"), { recursive: true });
      writeFileSync(join(dir, ".pi", "echo-voice.json"), JSON.stringify({ daidentity: { name: "Echo" } }));
      expect(loadProjectPersona(dir)).toEqual({ personaName: "Echo" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  test("name + voice override; unset keys keep base", () => {
    const out = applyPersonaOverride(base, { personaName: "Echo", voiceId: "en-US-AndrewNeural" });
    expect(out.personaName).toBe("Echo");
    expect(out.voiceId).toBe("en-US-AndrewNeural");
    expect(out.startupCatchphrases).toEqual(["Base ready."]); // untouched
    expect(out.speakCompletions).toBe(true); // non-persona keys untouched
  });

  test("catchphrases replace the base pool when present", () => {
    const out = applyPersonaOverride(base, { startupCatchphrases: ["Echo online."] });
    expect(out.startupCatchphrases).toEqual(["Echo online."]);
    expect(out.personaName).toBe("Pi"); // not overridden
  });
});

// ── integration: greeting + completion use the project override via ctx.cwd ───
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

beforeEach(() => {
  process.env = { ...originalEnv };
  process.env.ECHO_NOTIFY_URL = "http://voice.example/notify";
  process.env.ECHO_VOICE_PERSONA_NAME = "Pi";
  process.env.ECHO_VOICE_ID = "pi";
  projectDir = mkdtempSync(join(tmpdir(), "echo-pi-int-"));
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  writeFileSync(
    join(projectDir, ".pi", "echo-voice.json"),
    JSON.stringify({
      daidentity: { name: "Echo", voices: { main: { voiceId: "en-US-AndrewNeural" } }, startupCatchphrases: ["Echo online."] },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(projectDir, { recursive: true, force: true });
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
    expect(payloads[0].message).toBe("Echo online.");       // project catchphrase
    expect(payloads[0].voice_id).toBe("en-US-AndrewNeural"); // project voice, not "pi"
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

  test("no project file → base persona/voice (global stands)", async () => {
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

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
import { DEFAULT_PERSONA_GREETINGS } from "../../../shared/greeting";

// omp project persona override — SAME convention as the Claude Code and Pi adapters:
// a `daidentity` block in the host's native config. omp's config is YAML, layered
// `<cwd>/.omp/config.yml` (project) over `~/.omp/agent/config.yml` (global), project
// wins per key. Inside a repo with a project daidentity, the greeting + per-turn voice
// use that persona.

const GLOBAL_PATH = (home: string) => join(home, ".omp", "agent", "config.yml");
const PROJECT_PATH = (cwd: string) => join(cwd, ".omp", "config.yml");

// ── config-level unit tests (pure; injected readFile + explicit home) ────────
describe("loadProjectPersona — daidentity from omp YAML config layering", () => {
  const HOME = "/home/u";
  const CWD = "/proj";
  const reader = (files: Record<string, string>) => (path: string) => files[path] ?? null;

  // Clear any ambient PI_CODING_AGENT_DIR so ompAgentDir() falls back to the
  // injected `home` and the global path is deterministic.
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  beforeEach(() => { delete process.env.PI_CODING_AGENT_DIR; });
  afterEach(() => {
    if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  });

  test("no files → null", () => {
    expect(loadProjectPersona(CWD, () => null, HOME)).toBeNull();
  });

  test("project daidentity (YAML) → name + voice + catchphrases", () => {
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
      ].join("\n"),
    }), HOME);
    expect(o).toEqual({
      personaName: "Libby",
      voiceId: "en-GB-LibbyNeural",
      startupCatchphrases: ["Libby here.", "Libby online."],
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
      // Project sets only the voice → name + catchphrases fall through to global.
      [PROJECT_PATH(CWD)]: "daidentity:\n  voices:\n    main:\n      voiceId: en-GB-LibbyNeural\n",
    }), HOME);
    expect(o).toEqual({
      personaName: "GlobalOmp",
      voiceId: "en-GB-LibbyNeural",
      startupCatchphrases: ["Global line."],
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

describe("applyPersonaOverride — per-key override onto the base config", () => {
  const base: OmpVoiceConfig = {
    endpoint: "http://x/notify",
    title: "omp Notification",
    startupCatchphrases: ["Base ready."],
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

  test("name + voice override → name-default greeting pool; non-persona keys untouched", () => {
    const out = applyPersonaOverride(base, { personaName: "Libby", voiceId: "en-GB-LibbyNeural" });
    expect(out.personaName).toBe("Libby");
    expect(out.voiceId).toBe("en-GB-LibbyNeural");
    // Name override with no catchphrases of its own → name-templated default pool.
    expect(out.startupCatchphrases).toBe(DEFAULT_PERSONA_GREETINGS);
    expect(out.speakCompletions).toBe(true);
  });

  test("name override WITH its own catchphrases → keeps the custom pool", () => {
    const out = applyPersonaOverride(base, { personaName: "Libby", startupCatchphrases: ["Libby reporting."] });
    expect(out.startupCatchphrases).toEqual(["Libby reporting."]);
  });
});

// ── integration: greeting + completion use the override via ctx.cwd ──────────
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
  process.env.ECHO_VOICE_PERSONA_NAME = "omp";
  process.env.ECHO_VOICE_ID = "pi";
  // Isolate the GLOBAL config read: point omp's own PI_CODING_AGENT_DIR override at
  // an empty scratch dir so the resolver never reads Ed's real ~/.omp/agent/config.yml.
  // (homedir() ignores $HOME on macOS, so HOME redirection would NOT isolate it.)
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
    ].join("\n"),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("integration — omp project override flows through greeting + completion", () => {
  // Hermeticity guard: prove the global read is isolated to the scratch dir. With
  // PI_CODING_AGENT_DIR pointing at an empty agent dir, loadProjectPersona with no
  // project must resolve to null — so a green bar below reflects the project override,
  // not Ed's real ~/.omp/agent/config.yml.
  test("global config read is isolated (empty scratch agent dir → no override)", () => {
    expect(loadProjectPersona(undefined)).toBeNull();
  });

  test("session_start greeting uses the project catchphrase AND voice; source=omp", async () => {
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env)); // base persona=omp, voice=pi

    await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(projectDir));

    expect(payloads).toHaveLength(1);
    expect(payloads[0].message).toBe("Libby here, omp British voice."); // project catchphrase
    expect(payloads[0].voice_id).toBe("en-GB-LibbyNeural");             // project voice, not "pi"
    expect(payloads[0].source).toBe("omp");                             // omp-tagged
  });

  test("name+voice persona with NO catchphrases → greeting ANNOUNCES the persona name", async () => {
    // The /echo-voice-shaped case: daidentity has name + voice but no startupCatchphrases.
    // Previously the greeting was a neutral pool line ("Session ready.") with no name.
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const dir = mkdtempSync(join(tmpdir(), "echo-omp-nameonly-"));
    mkdirSync(join(dir, ".omp"), { recursive: true });
    writeFileSync(
      join(dir, ".omp", "config.yml"),
      "daidentity:\n  name: EchoOmp\n  voices:\n    main:\n      voiceId: en-GB-LibbyNeural\n",
    );
    try {
      const { handlers, api } = createMockOmp();
      echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));
      await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(dir));
      expect(payloads).toHaveLength(1);
      expect(payloads[0].voice_id).toBe("en-GB-LibbyNeural");
      expect(payloads[0].message).toContain("EchoOmp"); // NAME announced (was neutral before)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("per-turn completion uses the project voice", async () => {
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const { handlers, api } = createMockOmp();
    echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));

    await handlers.get("message_end")?.(
      { message: { role: "assistant", id: "m1", content: "Did the thing.\n🗣️ Shipped the fix." } },
      ctxWithCwd(projectDir),
    );

    expect(payloads).toHaveLength(1);
    expect(payloads[0].voice_id).toBe("en-GB-LibbyNeural");
    expect(payloads[0].source).toBe("omp");
  });

  test("project with no daidentity → base persona/voice", async () => {
    const payloads: any[] = [];
    globalThis.fetch = async (_i, init) => {
      payloads.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    };
    const bare = mkdtempSync(join(tmpdir(), "echo-omp-bare-"));
    try {
      const { handlers, api } = createMockOmp();
      echoVoiceOmpAdapter(api, loadOmpVoiceConfig(process.env));
      await handlers.get("session_start")?.({ reason: "startup" }, ctxWithCwd(bare));
      expect(payloads[0].voice_id).toBe("pi"); // base voice, no override
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

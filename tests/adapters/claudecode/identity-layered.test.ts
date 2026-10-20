import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCache, getIdentity } from "../../../adapters/claudecode/hooks/lib/identity";

// Layered identity resolution: project.local → project → global → defaults, per key.
// These tests drive getIdentity(projectDir, home) with throwaway dirs so no real
// ~/.claude or CLAUDE_PROJECT_DIR is touched.

const scratch: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

/** Write a `.claude/<file>` under `root` with the given JSON. */
function writeClaudeSettings(root: string, file: string, json: unknown): void {
  const dir = join(root, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify(json));
}

/** A fake $HOME whose ~/.claude/settings.json is the "global" layer. */
function fakeHome(daidentity: Record<string, unknown>): string {
  const home = tmp("echo-home-");
  writeClaudeSettings(home, "settings.json", { daidentity });
  return home;
}

const GLOBAL_ATLAS = {
  name: "Atlas",
  voices: { main: { voiceId: "atlas-voice" } },
  personality: { baseVoice: "en-US-Global", enthusiasm: 0.7 },
};

const voiceSpellings = [
  { spelling: "voices.main.voiceId", identity: (voiceId: string) => ({ voices: { main: { voiceId } } }) },
  { spelling: "voice.voiceId", identity: (voiceId: string) => ({ voice: { voiceId } }) },
  { spelling: "voiceId", identity: (voiceId: string) => ({ voiceId }) },
  { spelling: "mainDAVoiceID", identity: (voiceId: string) => ({ mainDAVoiceID: voiceId }) },
];

const voiceSpellingPairs = voiceSpellings.flatMap(lower => voiceSpellings.map(higher => ({
  lowerSpelling: lower.spelling,
  higherSpelling: higher.spelling,
  lowerIdentity: lower.identity,
  higherIdentity: higher.identity,
})));

afterEach(() => {
  clearCache();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getIdentity - layered precedence (project → global → default)", () => {
  test("no project dir → global identity", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const id = getIdentity("", home);
    expect(id.name).toBe("Atlas");
    expect(id.mainDAVoiceID).toBe("atlas-voice");
  });

  test("empty/absent global → neutral defaults, never an assumed name", () => {
    const home = tmp("echo-home-"); // no ~/.claude/settings.json
    const id = getIdentity("", home);
    expect(id.name).toBe("Assistant");
    expect(id.mainDAVoiceID).toBe("");
  });

  test("PRIMARY: project name + voice override global, per key", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { name: "Echo", voices: { main: { voiceId: "en-US-AndrewNeural" } } },
    });

    const id = getIdentity(proj, home);
    expect(id.name).toBe("Echo");
    expect(id.displayName).toBe("Echo");
    expect(id.mainDAVoiceID).toBe("en-US-AndrewNeural");
  });

  test("unset project keys fall through to global (personality inherited)", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { name: "Echo", voices: { main: { voiceId: "echo-voice" } } },
    });

    const id = getIdentity(proj, home);
    // Project set only name + voice; personality is not set locally → global wins.
    expect(id.personality?.baseVoice).toBe("en-US-Global");
    expect(id.personality?.enthusiasm).toBe(0.7);
  });

  test("deep-merge is per leaf: project voice wins, global name survives", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    // Project overrides ONLY the nested voiceId, sets no name.
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { voices: { main: { voiceId: "proj-only-voice" } } },
    });

    const id = getIdentity(proj, home);
    expect(id.name).toBe("Atlas"); // global name survives
    expect(id.mainDAVoiceID).toBe("proj-only-voice"); // project voice wins
  });
});


describe("getIdentity - settings.local.json overlay", () => {
  test("local overlay wins over project settings.json for the same key", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { name: "Echo", voices: { main: { voiceId: "checked-in-voice" } } },
    });
    writeClaudeSettings(proj, "settings.local.json", {
      daidentity: { voices: { main: { voiceId: "per-machine-voice" } } },
    });

    const id = getIdentity(proj, home);
    expect(id.mainDAVoiceID).toBe("per-machine-voice"); // local overlay wins
    expect(id.name).toBe("Echo"); // name not overridden locally → project value
  });

  test("malformed project settings.json is ignored, global stands", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.json"), "{ not valid json ");

    const id = getIdentity(proj, home);
    expect(id.name).toBe("Atlas");
    expect(id.mainDAVoiceID).toBe("atlas-voice");
  });
});

describe("getIdentity - cache is keyed by (home, projectDir)", () => {
  test("different project dirs resolve independently within one process", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const echo = tmp("echo-proj-");
    writeClaudeSettings(echo, "settings.json", { daidentity: { name: "Echo" } });
    const other = tmp("other-proj-"); // no override

    expect(getIdentity(echo, home).name).toBe("Echo");
    expect(getIdentity(other, home).name).toBe("Atlas");
  });
});

describe("getIdentity - global ECHO_VOICE_ID is the fallback voice", () => {
  test("no daidentity voice → the global ECHO_VOICE_ID", () => {
    const home = fakeHome({ name: "Atlas" });
    const id = getIdentity("", home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" });
    expect(id.mainDAVoiceID).toBe("en-IN-PrabhatNeural");
  });

  test("a global daidentity voice beats the global ECHO_VOICE_ID", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const id = getIdentity("", home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" });
    expect(id.mainDAVoiceID).toBe("atlas-voice");
  });

  test("a project-only daidentity voice beats the global ECHO_VOICE_ID", () => {
    const home = tmp("echo-home-");
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { voices: { main: { voiceId: "en-US-AndrewNeural" } } },
    });
    const id = getIdentity(proj, home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" });
    expect(id.mainDAVoiceID).toBe("en-US-AndrewNeural");
  });

  test("blank ECHO_VOICE_ID is unset → no voice_id, the daemon identity voice", () => {
    const home = tmp("echo-home-");
    expect(getIdentity("", home, { ECHO_VOICE_ID: "  " }).mainDAVoiceID).toBe("");
    clearCache();
    expect(getIdentity("", home, {}).mainDAVoiceID).toBe("");
  });

  test("the fallback persona name cannot replace the Claude Code name", () => {
    const home = tmp("echo-home-");
    const id = getIdentity("", home, {
      ECHO_VOICE_ID: "en-IN-PrabhatNeural",
      ECHO_VOICE_PERSONA_NAME: "Fallback",
    });
    expect(id.name).toBe("Assistant");
    expect(id.displayName).toBe("Assistant");
    expect(id.mainDAVoiceID).toBe("en-IN-PrabhatNeural");
  });
});

for (const [lowerLayer, higherLayer] of [
  ["global", "project"],
  ["global", "local"],
  ["project", "local"],
] as const) {
  describe(`voice scope wins over spelling: ${lowerLayer} → ${higherLayer}`, () => {
    test.each(voiceSpellingPairs)("$lowerSpelling → $higherSpelling", ({ lowerIdentity, higherIdentity }) => {
      const home = tmp("echo-home-");
      const project = tmp("echo-proj-");
      const layers: Record<string, Record<string, unknown>> = {
        global: { name: "Atlas" },
        project: {},
        local: {},
      };
      layers[lowerLayer] = { ...layers[lowerLayer], ...lowerIdentity("en-GB-ThomasNeural") };
      layers[higherLayer] = higherIdentity("en-US-AvaMultilingualNeural");
      writeClaudeSettings(home, "settings.json", { daidentity: layers.global });
      writeClaudeSettings(project, "settings.json", { daidentity: layers.project });
      writeClaudeSettings(project, "settings.local.json", { daidentity: layers.local });

      const id = getIdentity(project, home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" });
      expect(id.mainDAVoiceID).toBe("en-US-AvaMultilingualNeural");
      expect(id.name).toBe("Atlas");
    });
  });
}

describe("unconfigured voice aliases inherit the broader voice", () => {
  test.each(voiceSpellings)("blank $spelling does not hide the global voice", ({ identity }) => {
    const home = fakeHome(GLOBAL_ATLAS);
    const project = tmp("echo-proj-");
    writeClaudeSettings(project, "settings.json", { daidentity: identity("  ") });
    expect(getIdentity(project, home, {}).mainDAVoiceID).toBe("atlas-voice");
  });

  test("a prosody-only main voice does not hide a configured legacy voice", () => {
    const home = fakeHome({
      voices: { main: { speed: 0.9 } },
      voice: { voiceId: "en-US-AvaMultilingualNeural" },
    });
    const id = getIdentity("", home, {});
    expect(id.mainDAVoiceID).toBe("en-US-AvaMultilingualNeural");
    expect(id.voice?.speed).toBe(0.9);
  });
});

describe("identity voice consumers", () => {
  test.each([false, true])("algorithm voice preserves an explicit override: %s", (explicitAlgorithm) => {
    const home = fakeHome({
      name: "Atlas",
      voices: {
        main: { voiceId: "en-GB-ThomasNeural" },
        ...(explicitAlgorithm ? { algorithm: { voiceId: "en-US-AndrewNeural" } } : {}),
      },
    });
    const project = tmp("echo-proj-");
    writeClaudeSettings(project, "settings.json", { daidentity: { voiceId: "en-US-AvaMultilingualNeural" } });
    const result = Bun.spawnSync([
      process.execPath,
      "--eval",
      `import { getAlgorithmVoice, getSettings, getVoiceId } from ${JSON.stringify(join(process.cwd(), "adapters/claudecode/hooks/lib/identity.ts"))};
       console.log(JSON.stringify({ algorithm: getAlgorithmVoice().voiceId, main: getVoiceId(), settings: getSettings().daidentity.mainDAVoiceID }));`,
    ], {
      env: { ...process.env, HOME: home, CLAUDE_PROJECT_DIR: project },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      algorithm: explicitAlgorithm ? "en-US-AndrewNeural" : "en-US-AvaMultilingualNeural",
      main: "en-US-AvaMultilingualNeural",
      settings: "en-US-AvaMultilingualNeural",
    });
  });
});

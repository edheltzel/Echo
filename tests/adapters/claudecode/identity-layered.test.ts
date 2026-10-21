import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCache,
  getAlgorithmVoice,
  getIdentity,
  getSettings,
  getVoiceId,
  getVoiceProsody,
} from "../../../adapters/claudecode/hooks/lib/identity";

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
});

const voiceSpellings: Array<[string, (voiceId: unknown) => Record<string, unknown>]> = [
  ["voices.main.voiceId", (voiceId) => ({ voices: { main: { voiceId } } })],
  ["voice.voiceId", (voiceId) => ({ voice: { voiceId } })],
  ["voiceId", (voiceId) => ({ voiceId })],
  ["mainDAVoiceID", (voiceId) => ({ mainDAVoiceID: voiceId })],
];

describe.each(voiceSpellings)("documented scope order for %s", (_spelling, override) => {
  test.each(voiceSpellings)("project voice overrides global %s", (_inheritedSpelling, inherited) => {
    const home = fakeHome({ name: "Atlas", ...inherited("en-GB-ThomasNeural") });
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: override("en-US-AvaMultilingualNeural"),
    });

    const id = getIdentity(proj, home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" });
    expect(id.mainDAVoiceID).toBe("en-US-AvaMultilingualNeural");
    expect(id.name).toBe("Atlas");
  });

  test.each(voiceSpellings)("local voice overrides project %s", (_inheritedSpelling, inherited) => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: inherited("en-GB-ThomasNeural"),
    });
    writeClaudeSettings(proj, "settings.local.json", {
      daidentity: override("en-US-AvaMultilingualNeural"),
    });

    expect(getIdentity(proj, home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" }).mainDAVoiceID)
      .toBe("en-US-AvaMultilingualNeural");
  });

  test.each(["", "  ", null, 42])("unset voice %p inherits from the broader scope", (value) => {
    const home = fakeHome({ voices: { main: { voiceId: "en-GB-ThomasNeural" } } });
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", { daidentity: override(value) });

    expect(getIdentity(proj, home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" }).mainDAVoiceID)
      .toBe("en-GB-ThomasNeural");

    writeClaudeSettings(proj, "settings.json", {
      daidentity: { voices: { main: { voiceId: "en-US-AvaMultilingualNeural" } } },
    });
    writeClaudeSettings(proj, "settings.local.json", { daidentity: override(value) });
    clearCache();
    expect(getIdentity(proj, home, { ECHO_VOICE_ID: "en-IN-PrabhatNeural" }).mainDAVoiceID)
      .toBe("en-US-AvaMultilingualNeural");
  });

  test("voice helpers use the resolved main voice and retain explicit algorithm voices", () => {
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { voices: { main: { voiceId: "en-GB-ThomasNeural", speed: 0.9 } } },
    });
    writeClaudeSettings(proj, "settings.local.json", {
      daidentity: override("en-US-AvaMultilingualNeural"),
    });
    const previousProject = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = proj;
    try {
      expect(getVoiceId()).toBe("en-US-AvaMultilingualNeural");
      expect(getAlgorithmVoice().voiceId).toBe("en-US-AvaMultilingualNeural");
      expect(getSettings().daidentity?.mainDAVoiceID).toBe("en-US-AvaMultilingualNeural");
      expect(getVoiceProsody()?.speed).toBe(0.9);

      writeClaudeSettings(proj, "settings.json", {
        daidentity: {
          voices: {
            main: { voiceId: "en-GB-ThomasNeural", speed: 0.9 },
            algorithm: { voiceId: "en-US-AndrewNeural", voiceName: "Andrew" },
          },
        },
      });
      clearCache();
      expect(getAlgorithmVoice()).toEqual({ voiceId: "en-US-AndrewNeural", voiceName: "Andrew" });
    } finally {
      if (previousProject === undefined) delete process.env.CLAUDE_PROJECT_DIR;
      else process.env.CLAUDE_PROJECT_DIR = previousProject;
    }
  });
});

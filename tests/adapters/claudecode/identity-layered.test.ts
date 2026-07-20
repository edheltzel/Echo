import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCache, getIdentity } from "../../../adapters/claudecode/hooks/lib/identity";

// Layered identity resolution: project.local → project → global → defaults, per key.
// The feature is a per-project spoken identity (name + voice); catchphrases ride the
// same resolver. These tests drive getIdentity(projectDir, home) with throwaway dirs
// so no real ~/.claude or CLAUDE_PROJECT_DIR is touched.

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
  startupCatchphrases: ["Atlas online.", "Atlas standing by."],
  personality: { baseVoice: "en-US-Global", enthusiasm: 0.7 },
};

afterEach(() => {
  clearCache();
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("getIdentity — layered precedence (project → global → default)", () => {
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

describe("getIdentity — catchphrases (secondary, rides the same resolver)", () => {
  test("project catchphrases replace the global pool wholesale when present", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { name: "Echo", startupCatchphrases: ["Echo online.", "Echo here."] },
    });

    const id = getIdentity(proj, home);
    // Array is atomic — the global two-phrase pool is replaced, not merged.
    expect(id.startupCatchphrases).toEqual(["Echo online.", "Echo here."]);
  });

  test("no project catchphrases → global pool", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const proj = tmp("echo-proj-");
    writeClaudeSettings(proj, "settings.json", {
      daidentity: { name: "Echo", voices: { main: { voiceId: "echo-voice" } } },
    });

    const id = getIdentity(proj, home);
    expect(id.startupCatchphrases).toEqual(["Atlas online.", "Atlas standing by."]);
  });
});

describe("getIdentity — settings.local.json overlay", () => {
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

describe("getIdentity — cache is keyed by (home, projectDir)", () => {
  test("different project dirs resolve independently within one process", () => {
    const home = fakeHome(GLOBAL_ATLAS);
    const echo = tmp("echo-proj-");
    writeClaudeSettings(echo, "settings.json", { daidentity: { name: "Echo" } });
    const other = tmp("other-proj-"); // no override

    expect(getIdentity(echo, home).name).toBe("Echo");
    expect(getIdentity(other, home).name).toBe("Atlas");
  });
});

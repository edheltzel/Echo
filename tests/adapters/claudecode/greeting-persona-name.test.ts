import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCache, getIdentity } from "../../../adapters/claudecode/hooks/lib/identity";
import { resolveStartupCatchphrase } from "../../../adapters/claudecode/hooks/lib/greeting";

// A project persona name must drive the STARTUP greeting — not just the voice.
// The regression the neutral test global (identity-layered's GLOBAL_ATLAS) missed:
// Ed's real ~/.claude sets an explicit `displayName` AND a pool of "Atlas ..." literal
// catchphrases, so a repo that set only name+voice (via /echo-voice) inherited the
// global displayName and the "Atlas" pool → greeting said "Atlas" in the project voice.
const GLOBAL_ATLAS = {
  name: "Atlas",
  displayName: "Atlas",
  voices: { main: { voiceId: "atlas-voice" } },
  startupCatchphrases: ["Atlas online and standing by.", "Atlas standing by."],
};

const scratch: string[] = [];
function tmp(prefix: string): string { const d = mkdtempSync(join(tmpdir(), prefix)); scratch.push(d); return d; }
function writeSettings(root: string, json: unknown): void {
  const dir = join(root, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(json));
}
function fakeHome(): string { const h = tmp("echo-home-"); writeSettings(h, { daidentity: GLOBAL_ATLAS }); return h; }
const firstPick = () => 0; // deterministic catchphrase pick

afterEach(() => { clearCache(); for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("Claude Code startup greeting announces the project persona name", () => {
  test("displayName precedence: project name overrides an inherited global displayName", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-");
    writeSettings(proj, { daidentity: { name: "EchoCC", voices: { main: { voiceId: "en-US-AndrewNeural" } } } });

    const id = getIdentity(proj, home);
    expect(id.displayName).toBe("EchoCC");           // was "Atlas" (the bug)
    expect(id.mainDAVoiceID).toBe("en-US-AndrewNeural");
    expect(id.personaFromProject).toBe(true);
    expect(id.catchphrasesFromProject).toBe(false);
  });

  test("name+voice, no catchphrases → greeting announces the project name, not Atlas", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-");
    writeSettings(proj, { daidentity: { name: "EchoCC", voices: { main: { voiceId: "en-US-AndrewNeural" } } } });

    const greeting = resolveStartupCatchphrase(getIdentity(proj, home), firstPick);
    expect(greeting).toContain("EchoCC");
    expect(greeting).not.toContain("Atlas");
    expect(greeting).toBe("EchoCC online and standing by.");
  });

  test("project sets its OWN catchphrases → those win over the name default", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-");
    writeSettings(proj, { daidentity: { name: "EchoCC", startupCatchphrases: ["Echo reporting."] } });

    const id = getIdentity(proj, home);
    expect(id.catchphrasesFromProject).toBe(true);
    expect(resolveStartupCatchphrase(id, firstPick)).toBe("Echo reporting.");
  });

  test("no project persona → global Atlas greeting stays untouched", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-"); // no project .claude persona

    const id = getIdentity(proj, home);
    expect(id.displayName).toBe("Atlas");
    expect(id.personaFromProject).toBe(false);
    expect(resolveStartupCatchphrase(id, firstPick)).toBe("Atlas online and standing by.");
  });
});

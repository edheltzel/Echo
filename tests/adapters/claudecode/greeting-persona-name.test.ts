import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCache, getIdentity } from "../../../adapters/claudecode/hooks/lib/identity";
import {
  resolveStartupCatchphrase,
  resolveStartupCatchphrases,
} from "../../../adapters/claudecode/hooks/lib/greeting";

// A project persona name must drive the STARTUP greeting - not just the voice.
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
function fakeHome(daidentity: Record<string, unknown> = GLOBAL_ATLAS): string {
  const h = tmp("echo-home-");
  writeSettings(h, { daidentity });
  return h;
}
const firstPick = () => 0; // deterministic catchphrase pick

afterEach(() => { clearCache(); for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("Claude Code startup greeting stays nameless unless sayName", () => {
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

  test("project name inherits global custom catchphrases verbatim", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-");
    writeSettings(proj, { daidentity: { name: "EchoCC", voices: { main: { voiceId: "en-US-AndrewNeural" } } } });

    const greeting = resolveStartupCatchphrase(getIdentity(proj, home), firstPick);
    expect(greeting).toBe("Atlas online and standing by.");
  });

  test("name+voice, no configured catchphrases, no sayName is nameless", () => {
    const home = fakeHome({ name: "Atlas", displayName: "Atlas" });
    const proj = tmp("echo-proj-");
    writeSettings(proj, { daidentity: { name: "EchoCC", voices: { main: { voiceId: "en-US-AndrewNeural" } } } });

    const id = getIdentity(proj, home);
    const greeting = resolveStartupCatchphrase(id, firstPick);
    expect(resolveStartupCatchphrases(id)).toEqual([
      "standing by",
      "ready when you are",
      "waiting for direction",
      "engaged",
    ]);
    expect(greeting).toBe("standing by");
  });

  test("sayName true uses the named default pool", () => {
    const home = fakeHome({ name: "Atlas", displayName: "Atlas" });
    const proj = tmp("echo-proj-");
    writeSettings(proj, {
      daidentity: { name: "EchoCC", sayName: true, voices: { main: { voiceId: "en-US-AndrewNeural" } } },
    });

    const greeting = resolveStartupCatchphrase(getIdentity(proj, home), firstPick);
    expect(greeting).toBe("EchoCC, standing by");
  });

  test("project sets its OWN catchphrases → those win over the name default", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-");
    writeSettings(proj, { daidentity: { name: "EchoCC", startupCatchphrases: ["Echo reporting."] } });

    const id = getIdentity(proj, home);
    expect(id.catchphrasesFromProject).toBe(true);
    expect(resolveStartupCatchphrase(id, firstPick)).toBe("Echo reporting.");
  });

  test("legacy singular startupCatchphrase is honored", () => {
    const home = fakeHome({
      name: "Atlas",
      displayName: "Atlas",
      startupCatchphrase: "Legacy greeting.",
    });
    const proj = tmp("echo-proj-");

    const id = getIdentity(proj, home);
    expect(resolveStartupCatchphrases(id)).toEqual(["Legacy greeting."]);
    expect(resolveStartupCatchphrase(id, firstPick)).toBe("Legacy greeting.");
  });

  test("sayName false removes name tokens from the dedup pool", () => {
    const home = fakeHome({
      name: "Atlas",
      displayName: "Atlas",
      startupCatchphrases: ["{name}, ready"],
    });
    const proj = tmp("echo-proj-");

    expect(resolveStartupCatchphrases(getIdentity(proj, home))).toEqual(["ready"]);
  });

  test("no project persona → global Atlas greeting stays untouched", () => {
    const home = fakeHome();
    const proj = tmp("echo-proj-"); // no project .claude persona

    const id = getIdentity(proj, home);
    expect(id.displayName).toBe("Atlas");
    expect(id.personaFromProject).toBe(false);
    expect(resolveStartupCatchphrase(id, firstPick)).toBe("Atlas online and standing by.");
    expect(id.sayName).toBe(false);
  });
});

// The greeting hook runs its work at import time (it is a hook script, not a
// module), so its daemon address is asserted by reading the source: both POST
// paths must resolve through @echo/shared rather than pinning :3246 themselves.
describe("VoiceGreeting hook resolves the daemon address, never hardcodes it", () => {
  const source = readFileSync(
    join("adapters", "claudecode", "hooks", "VoiceGreeting.hook.ts"),
    "utf8",
  );

  test("both POST targets come from the shared resolver", () => {
    expect(source).toContain("@echo/shared/daemon-endpoints.ts");
    expect(source).toContain("loadEchoConfiguration()");
    expect(source).toContain("resolveNotifyUrl(ECHO_CONFIG)");
    expect(source).toContain("resolvePersonalityUrl(ECHO_CONFIG)");
  });

  test("no hardcoded daemon URL survives, so ECHO_DAEMON_URL retargets the greeting", () => {
    const offenders = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /(['"`])https?:\/\/[^'"`]*:3246[^'"`]*\1/.test(line));
    expect(offenders).toEqual([]);
  });
});

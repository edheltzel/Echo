import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import atlasVoicePiAdapter from "../../../adapters/pi/index";
import { loadProjectPersona } from "../../../adapters/pi/config";

// The `/echo-voice` command registered by the Pi adapter writes a `daidentity`
// persona into <cwd>/.pi/settings.json, and the SAME reader used at session_start
// (loadProjectPersona) must resolve it — a writer↔reader round-trip.

type CmdHandler = (args: string, ctx: unknown) => Promise<void>;

function registerAndGetEchoVoice(): { handler: CmdHandler; notes: Array<{ msg: string; type?: string }> } {
  const commands = new Map<string, { handler: CmdHandler }>();
  const notes: Array<{ msg: string; type?: string }> = [];
  const api = {
    on: () => {},
    registerCommand: (name: string, opts: { handler: CmdHandler }) => commands.set(name, opts),
  } as unknown as ExtensionAPI;
  atlasVoicePiAdapter(api);
  const cmd = commands.get("echo-voice");
  if (!cmd) throw new Error("pi adapter did not register /echo-voice");
  return { handler: cmd.handler, notes };
}

function ctx(cwd: string, notes: Array<{ msg: string; type?: string }>, inputs: (string | undefined)[] = []) {
  const queue = [...inputs];
  return { cwd, ui: { input: async () => queue.shift(), notify: (msg: string, type?: string) => notes.push({ msg, type }) } };
}

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "echo-pi-cmd-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("pi /echo-voice — writer↔reader round-trip", () => {
  test("writes .pi/settings.json that loadProjectPersona resolves", async () => {
    const { handler, notes } = registerAndGetEchoVoice();
    await handler("Echo en-US-AndrewNeural", ctx(cwd, notes));

    // loadProjectPersona reads the SAME file the command wrote (home pointed away so
    // only the project file contributes).
    const persona = loadProjectPersona(cwd, undefined, mkdtempSync(join(tmpdir(), "echo-pi-home-")));
    expect(persona).toEqual({ personaName: "Echo", voiceId: "en-US-AndrewNeural" });
  });

  test("merges into an existing settings.json, preserving unrelated keys", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ theme: "dark", defaultProvider: "anthropic" }));

    const { handler, notes } = registerAndGetEchoVoice();
    await handler("Echo en-GB-RyanNeural", ctx(cwd, notes));

    const written = JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"));
    expect(written.theme).toBe("dark");            // preserved
    expect(written.defaultProvider).toBe("anthropic");
    expect(written.daidentity.voices.main.voiceId).toBe("en-GB-RyanNeural");
    expect(loadProjectPersona(cwd, undefined, mkdtempSync(join(tmpdir(), "echo-pi-home-")))?.personaName).toBe("Echo");
  });
});

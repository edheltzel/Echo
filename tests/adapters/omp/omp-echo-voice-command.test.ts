import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import echoVoiceOmpAdapter from "../../../adapters/omp/index";
import { loadProjectPersona } from "../../../adapters/omp/config";

// The `/echo-voice` command registered by the omp adapter writes a `daidentity`
// persona into <cwd>/.omp/config.yml (YAML), and the SAME reader used at
// session_start (loadProjectPersona) must resolve it — a writer↔reader round-trip
// that also proves Bun.YAML stringify↔parse agree.

const bunYaml = (Bun as unknown as { YAML: { parse: (s: string) => any } }).YAML;

type CmdHandler = (args: string, ctx: unknown) => Promise<void>;

function registerAndGetEchoVoice(): { handler: CmdHandler; notes: Array<{ msg: string; type?: string }> } {
  const commands = new Map<string, { handler: CmdHandler }>();
  const notes: Array<{ msg: string; type?: string }> = [];
  const api = {
    on: () => {},
    registerCommand: (name: string, opts: { handler: CmdHandler }) => commands.set(name, opts),
  } as unknown as ExtensionAPI;
  echoVoiceOmpAdapter(api);
  const cmd = commands.get("echo-voice");
  if (!cmd) throw new Error("omp adapter did not register /echo-voice");
  return { handler: cmd.handler, notes };
}

function ctx(cwd: string, notes: Array<{ msg: string; type?: string }>, inputs: (string | undefined)[] = []) {
  const queue = [...inputs];
  return { cwd, ui: { input: async () => queue.shift(), notify: (msg: string, type?: string) => notes.push({ msg, type }) } };
}

const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
let cwd: string;
let emptyAgentDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "echo-omp-cmd-"));
  // Isolate the GLOBAL config read: point omp's own PI_CODING_AGENT_DIR at an empty
  // scratch dir (homedir() ignores $HOME on macOS, so HOME redirection would not).
  emptyAgentDir = mkdtempSync(join(tmpdir(), "echo-omp-agent-"));
  process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
});
afterEach(() => {
  if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(emptyAgentDir, { recursive: true, force: true });
});

describe("omp /echo-voice — writer↔reader round-trip (YAML)", () => {
  test("writes .omp/config.yml that loadProjectPersona resolves", async () => {
    const { handler, notes } = registerAndGetEchoVoice();
    await handler("Libby en-GB-LibbyNeural", ctx(cwd, notes));

    expect(loadProjectPersona(cwd)).toEqual({ personaName: "Libby", voiceId: "en-GB-LibbyNeural" });
  });

  test("merges into an existing config.yml, preserving unrelated keys", async () => {
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    writeFileSync(join(cwd, ".omp", "config.yml"), "theme: dark\ndefaultThinkingLevel: auto\n");

    const { handler, notes } = registerAndGetEchoVoice();
    await handler("Libby en-GB-LibbyNeural", ctx(cwd, notes));

    const doc = bunYaml.parse(readFileSync(join(cwd, ".omp", "config.yml"), "utf8"));
    expect(doc.theme).toBe("dark");                 // preserved
    expect(doc.defaultThinkingLevel).toBe("auto");
    expect(doc.daidentity.voices.main.voiceId).toBe("en-GB-LibbyNeural");
    expect(loadProjectPersona(cwd)?.personaName).toBe("Libby");
  });

  test("invalid voice → error, no file written", async () => {
    const { handler, notes } = registerAndGetEchoVoice();
    await handler("Libby not-a-voice", ctx(cwd, notes));
    expect(loadProjectPersona(cwd)).toBeNull();
    expect(notes.at(-1)?.type).toBe("error");
  });
});

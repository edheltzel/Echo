import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPersona,
  createEchoVoiceCommand,
  looksLikeEdgeVoice,
  MalformedConfigError,
  mergePersonaJson,
  mergePersonaYaml,
  parsePersonaArgs,
  type ScaffoldContext,
} from "../../shared/persona-scaffold";

// Host-neutral core of the pi/omp `/echo-voice` command: validate an edge-tts
// voice, parse args, and merge a `daidentity` persona into JSON/YAML config while
// preserving every other key. The writer is STRICT — a present-but-unparseable
// file aborts rather than clobbering it (unlike the lenient config readers).

const bunYaml = (Bun as unknown as { YAML: { parse: (s: string) => any } }).YAML;

describe("looksLikeEdgeVoice", () => {
  test("accepts real edge-tts names", () => {
    for (const v of ["en-US-AndrewNeural", "en-GB-RyanNeural", "en-GB-LibbyNeural", "zh-CN-liaoning-XiaobeiNeural"]) {
      expect(looksLikeEdgeVoice(v)).toBe(true);
    }
  });
  test("rejects agent keys, ElevenLabs ids, empty", () => {
    for (const v of ["pi", "themis", "en-US-Andrew", "AndrewNeural", "", null, undefined]) {
      expect(looksLikeEdgeVoice(v as any)).toBe(false);
    }
  });
});

describe("parsePersonaArgs", () => {
  test("splits name + voice; ignores extra whitespace/tokens", () => {
    expect(parsePersonaArgs("Echo en-US-AndrewNeural")).toEqual({ name: "Echo", voice: "en-US-AndrewNeural" });
    expect(parsePersonaArgs("  Echo   en-US-AndrewNeural extra ")).toEqual({ name: "Echo", voice: "en-US-AndrewNeural" });
  });
  test("partial / empty args", () => {
    expect(parsePersonaArgs("Echo")).toEqual({ name: "Echo", voice: undefined });
    expect(parsePersonaArgs("")).toEqual({ name: undefined, voice: undefined });
    expect(parsePersonaArgs("   ")).toEqual({ name: undefined, voice: undefined });
  });
});

describe("applyPersona — sets persona keys, preserves siblings", () => {
  test("preserves top-level keys, daidentity siblings, and other voices", () => {
    const out = applyPersona(
      {
        theme: "dark",
        daidentity: {
          startupCatchphrases: ["Keep me."],
          voices: { notification: { voiceId: "en-US-AriaNeural" } },
        },
      },
      "Echo",
      "en-US-AndrewNeural",
    );
    expect(out.theme).toBe("dark");
    expect(out.daidentity.name).toBe("Echo");
    expect(out.daidentity.voices.main.voiceId).toBe("en-US-AndrewNeural");
    expect(out.daidentity.voices.notification.voiceId).toBe("en-US-AriaNeural"); // preserved
    expect(out.daidentity.startupCatchphrases).toEqual(["Keep me."]);            // preserved
  });
});

describe("mergePersonaJson", () => {
  test("absent (null) → fresh block, pretty + trailing newline", () => {
    const out = mergePersonaJson(null, "Echo", "en-US-AndrewNeural");
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({ daidentity: { name: "Echo", voices: { main: { voiceId: "en-US-AndrewNeural" } } } });
  });
  test("empty string → fresh block (no data to lose)", () => {
    expect(JSON.parse(mergePersonaJson("   ", "Echo", "en-US-AndrewNeural")).daidentity.name).toBe("Echo");
  });
  test("preserves unrelated keys in an existing file", () => {
    const existing = JSON.stringify({ theme: "dark", defaultProvider: "anthropic", daidentity: { startupCatchphrases: ["Hi."] } });
    const parsed = JSON.parse(mergePersonaJson(existing, "Echo", "en-GB-RyanNeural"));
    expect(parsed.theme).toBe("dark");
    expect(parsed.defaultProvider).toBe("anthropic");
    expect(parsed.daidentity.name).toBe("Echo");
    expect(parsed.daidentity.voices.main.voiceId).toBe("en-GB-RyanNeural");
    expect(parsed.daidentity.startupCatchphrases).toEqual(["Hi."]);
  });
  test("malformed JSON → throws MalformedConfigError (never returns {})", () => {
    expect(() => mergePersonaJson("{ not json", "Echo", "en-US-AndrewNeural")).toThrow(MalformedConfigError);
  });
  test("non-object JSON (array) → throws", () => {
    expect(() => mergePersonaJson("[1,2,3]", "Echo", "en-US-AndrewNeural")).toThrow(MalformedConfigError);
  });
});

describe("mergePersonaYaml", () => {
  test("absent → fresh block, re-parses with persona set", () => {
    const doc = bunYaml.parse(mergePersonaYaml(null, "Libby", "en-GB-LibbyNeural"));
    expect(doc.daidentity.name).toBe("Libby");
    expect(doc.daidentity.voices.main.voiceId).toBe("en-GB-LibbyNeural");
  });
  test("preserves unrelated keys in existing YAML", () => {
    const existing = "theme: dark\ndefaultThinkingLevel: auto\ndaidentity:\n  startupCatchphrases:\n    - Hi.\n";
    const doc = bunYaml.parse(mergePersonaYaml(existing, "Libby", "en-GB-LibbyNeural"));
    expect(doc.theme).toBe("dark");
    expect(doc.defaultThinkingLevel).toBe("auto");
    expect(doc.daidentity.name).toBe("Libby");
    expect(doc.daidentity.voices.main.voiceId).toBe("en-GB-LibbyNeural");
    expect(doc.daidentity.startupCatchphrases).toEqual(["Hi."]);
  });
  test("malformed YAML → throws MalformedConfigError", () => {
    expect(() => mergePersonaYaml("daidentity:\n  name: [unterminated", "Libby", "en-GB-LibbyNeural")).toThrow(MalformedConfigError);
  });
});

// ── createEchoVoiceCommand — the interactive flow (mock ctx, tmp cwd) ─────────
describe("createEchoVoiceCommand — flow + never-clobber", () => {
  let cwd: string;
  const notes: Array<{ msg: string; type?: string }> = [];

  function mkCtx(over: Partial<ScaffoldContext> & { inputs?: (string | undefined)[] } = {}): ScaffoldContext {
    const queue = [...(over.inputs ?? [])];
    return {
      cwd: "cwd" in over ? over.cwd : cwd,
      ui: {
        input: async () => queue.shift(),
        notify: (msg, type) => { notes.push({ msg, type }); },
      },
    };
  }

  const jsonCmd = createEchoVoiceCommand({ configPath: [".pi", "settings.json"], merge: mergePersonaJson });
  const target = () => join(cwd, ".pi", "settings.json");

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "echo-scaffold-")); notes.length = 0; });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  test("args supply name + voice → writes merged block, confirms", async () => {
    await jsonCmd.handler("Echo en-US-AndrewNeural", mkCtx());
    const written = JSON.parse(readFileSync(target(), "utf8"));
    expect(written.daidentity).toEqual({ name: "Echo", voices: { main: { voiceId: "en-US-AndrewNeural" } } });
    expect(notes.at(-1)?.type).toBe("info");
    expect(notes.at(-1)?.msg).toContain("Echo");
  });

  test("missing name + voice are prompted via ctx.ui.input", async () => {
    await jsonCmd.handler("", mkCtx({ inputs: ["Echo", "en-GB-RyanNeural"] }));
    expect(JSON.parse(readFileSync(target(), "utf8")).daidentity.voices.main.voiceId).toBe("en-GB-RyanNeural");
  });

  test("invalid voice → error, no file written", async () => {
    await jsonCmd.handler("Echo not-a-voice", mkCtx());
    expect(existsSync(target())).toBe(false);
    expect(notes.at(-1)?.type).toBe("error");
  });

  test("cancelled (no name given) → warning, no file", async () => {
    await jsonCmd.handler("", mkCtx({ inputs: [undefined] }));
    expect(existsSync(target())).toBe(false);
    expect(notes.at(-1)?.type).toBe("warning");
  });

  test("no cwd → error, nothing written", async () => {
    await jsonCmd.handler("Echo en-US-AndrewNeural", mkCtx({ cwd: undefined }));
    expect(notes.at(-1)?.type).toBe("error");
  });

  test("existing MALFORMED config → aborts, leaves original untouched", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    const original = "{ this is not valid json";
    writeFileSync(target(), original);
    await jsonCmd.handler("Echo en-US-AndrewNeural", mkCtx());
    expect(readFileSync(target(), "utf8")).toBe(original);      // NOT overwritten
    expect(notes.at(-1)?.type).toBe("error");
    expect(notes.at(-1)?.msg).toContain("Not writing");
  });
});

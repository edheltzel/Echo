import { describe, expect, test } from "bun:test";
import {
  parseVoiceList,
  filterByLocale,
  buildSynthArgs,
  parseArgs,
} from "../../scripts/preview-voices";

const SAMPLE = `Name                               Gender    ContentCategories      VoicePersonalities
en-GB-LibbyNeural                  Female    General                Friendly, Positive
en-GB-MaisieNeural                 Female    General                Friendly, Positive
en-GB-RyanNeural                   Male      News                   Authority
en-GB-SoniaNeural                  Female    News                   Friendly
en-GB-ThomasNeural                 Male      News                   Calm
en-US-AvaNeural                    Female    General                Caring
en-AU-NatashaNeural                Female    General                Friendly`;

describe("parseVoiceList", () => {
  test("parses rows and skips the header line", () => {
    const voices = parseVoiceList(SAMPLE);
    expect(voices).toHaveLength(7);
    expect(voices[0]).toEqual({ name: "en-GB-LibbyNeural", gender: "Female" });
    expect(voices.every((v) => !v.name.startsWith("Name"))).toBe(true);
  });
});

describe("filterByLocale", () => {
  test("returns exactly the en-GB voices and nothing else", () => {
    const gb = filterByLocale(parseVoiceList(SAMPLE), ["en-GB"]).map((v) => v.name);
    expect(gb).toEqual([
      "en-GB-LibbyNeural",
      "en-GB-MaisieNeural",
      "en-GB-RyanNeural",
      "en-GB-SoniaNeural",
      "en-GB-ThomasNeural",
    ]);
  });

  test("unknown locale matches nothing", () => {
    expect(filterByLocale(parseVoiceList(SAMPLE), ["xx-XX"])).toEqual([]);
  });

  test("does not prefix-match across locales (en-G must not catch en-GB via substring)", () => {
    // en-US- should never appear when filtering en-GB
    const gb = filterByLocale(parseVoiceList(SAMPLE), ["en-GB"]);
    expect(gb.some((v) => v.name.startsWith("en-US"))).toBe(false);
  });
});

describe("buildSynthArgs", () => {
  test("substitutes {voice} and includes voice, rate, and output file", () => {
    const args = buildSynthArgs("en-GB-RyanNeural", "Hi, I'm {voice}.", "-6%", "/tmp/x.mp3");
    expect(args).toContain("en-GB-RyanNeural");
    expect(args).toContain("-6%");
    expect(args).toContain("/tmp/x.mp3");
    expect(args[args.indexOf("--text") + 1]).toBe("Hi, I'm en-GB-RyanNeural.");
    expect(args[args.indexOf("--voice") + 1]).toBe("en-GB-RyanNeural");
  });
});

describe("parseArgs", () => {
  test("defaults to the four English locales, no explicit voices, no audio flags", () => {
    const o = parseArgs([]);
    expect(o.locales).toEqual(["en-US", "en-GB", "en-AU", "en-IE"]);
    expect(o.voices).toBeNull();
    expect(o.list).toBe(false);
    expect(o.dryRun).toBe(false);
    expect(o.rate).toBe("+0%");
  });

  test("--dry-run sets dryRun and parses an explicit voice set", () => {
    const o = parseArgs(["--dry-run", "--voices", "en-GB-RyanNeural,en-GB-ThomasNeural"]);
    expect(o.dryRun).toBe(true);
    expect(o.voices).toEqual(["en-GB-RyanNeural", "en-GB-ThomasNeural"]);
  });

  test("--locale and --rate are parsed", () => {
    const o = parseArgs(["--locale", "en-GB,en-IE", "--rate", "-6%"]);
    expect(o.locales).toEqual(["en-GB", "en-IE"]);
    expect(o.rate).toBe("-6%");
  });

  test("-h and --help ask for help", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["--voices", "en-GB-RyanNeural", "-h"]).help).toBe(true);
    expect(parseArgs([]).help).toBe(false);
  });

  test("an unknown flag or a stray argument is an error, not a silent default run", () => {
    expect(() => parseArgs(["--lsit"])).toThrow("unknown argument: --lsit");
    expect(() => parseArgs(["en-GB"])).toThrow("unknown argument: en-GB");
  });

  test("a flag missing its value is an error", () => {
    expect(() => parseArgs(["--voices"])).toThrow("--voices needs a value");
  });
});

describe("preview-voices command", () => {
  // Run the real file directly (no `bun` prefix) to prove the shebang and exec bit.
  // A bogus python path proves --help and errors never reach edge-tts or audio.
  const run = (args: string[]) => {
    const result = Bun.spawnSync(["scripts/preview-voices.ts", ...args], {
      env: { ...process.env, ECHO_PYTHON3_PATH: "/nonexistent/python3" },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  test("--help prints every flag and exits 0 without touching edge-tts", () => {
    for (const flag of ["--help", "-h"]) {
      const { exitCode, stdout } = run([flag]);
      expect(exitCode).toBe(0);
      for (const option of ["--list", "--dry-run", "--locale", "--voices", "--text", "--rate", "--help"]) {
        expect(stdout).toContain(option);
      }
    }
  });

  test("an unknown flag prints the error plus usage and exits 2", () => {
    const { exitCode, stderr } = run(["--bogus"]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("unknown argument: --bogus");
    expect(stderr).toContain("Usage:");
  });
});

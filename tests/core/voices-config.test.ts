import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("voices.json edgetts mappings", () => {
  const config = JSON.parse(readFileSync("core/voices.json", "utf8"));
  const mappings: [string, any][] = [
    ["identity", config.identity],
    ...Object.entries(config.agents),
  ];

  test("identity and every agent declare a non-empty edgetts.voice", () => {
    for (const [name, mapping] of mappings) {
      expect(mapping.edgetts, `${name} has an edgetts block`).toBeDefined();
      expect(typeof mapping.edgetts.voice, `${name}.edgetts.voice is a string`).toBe("string");
      expect(mapping.edgetts.voice.length, `${name}.edgetts.voice is non-empty`).toBeGreaterThan(0);
    }
  });

  test("edge voices are English-locale neural voice ids", () => {
    const pattern = /^en-(US|GB|AU|IE)-[A-Za-z]+Neural$/;
    for (const [name, mapping] of mappings) {
      expect(mapping.edgetts.voice, `${name} uses an en-* Neural voice`).toMatch(pattern);
    }
  });

  test("identity (Atlas) uses the shared British Ryan voice (matches Pi/omp)", () => {
    // All coding agents speak with the same en-GB-RyanNeural voice at -8% (0.92);
    // Pi/omp reach it via voice_id "pi", Claude via the no-voice_id identity path.
    expect(config.identity.edgetts.voice).toBe("en-GB-RyanNeural");
    expect(config.identity.edgetts.speed).toBe(0.92);
  });
});

describe("voices-schema.json", () => {
  const schema = JSON.parse(readFileSync("core/voices-schema.json", "utf8"));

  test("$defs/voiceMapping declares an edgetts object with a required voice", () => {
    const edgetts = schema.$defs.voiceMapping.properties.edgetts;
    expect(edgetts).toBeDefined();
    expect(edgetts.type).toBe("object");
    expect(edgetts.properties.voice.type).toBe("string");
    expect(edgetts.required).toContain("voice");
  });
});

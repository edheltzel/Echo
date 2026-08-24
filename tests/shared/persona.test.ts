import { describe, expect, test } from "bun:test";
import { DEFAULT_PERSONA_GREETINGS, pickStartupCatchphrase } from "../../shared/greeting.ts";
import {
  applyPersonaOverride,
  booleanEnv,
  mergeDaidentity,
  parseJsonDaidentity,
  shouldSuppressVoice,
  type PersonaFields,
} from "../../shared/persona.ts";

describe("booleanEnv", () => {
  test("accepts common truthy and falsey spellings", () => {
    expect(booleanEnv("true", false)).toBe(true);
    expect(booleanEnv("1", false)).toBe(true);
    expect(booleanEnv("yes", false)).toBe(true);
    expect(booleanEnv("off", true)).toBe(false);
    expect(booleanEnv(undefined, true)).toBe(true);
    expect(booleanEnv("maybe", true)).toBe(true);
  });
});

describe("mergeDaidentity", () => {
  test("project wins per key; unset keys fall through", () => {
    expect(mergeDaidentity(
      { voices: { main: { voiceId: "project-voice" } } },
      { name: "Global", voiceId: "global-voice", startupCatchphrases: ["Hi."] },
    )).toEqual({
      personaName: "Global",
      voiceId: "project-voice",
      startupCatchphrases: ["Hi."],
    });
  });

  test("null + null is null", () => {
    expect(mergeDaidentity(null, null)).toBeNull();
  });
});

describe("parseJsonDaidentity", () => {
  test("returns the daidentity object or null", () => {
    expect(parseJsonDaidentity('{"daidentity":{"name":"X"}}')).toEqual({ name: "X" });
    expect(parseJsonDaidentity("{")).toBeNull();
    expect(parseJsonDaidentity(null)).toBeNull();
  });
});

describe("applyPersonaOverride", () => {
  const base: PersonaFields = {
    personaName: "Base",
    voiceId: "base",
    startupCatchphrases: ["Base ready."],
  };

  test("null override returns the same reference", () => {
    expect(applyPersonaOverride(base, null)).toBe(base);
  });

  test("name without catchphrases switches to the name pool", () => {
    const out = applyPersonaOverride(base, { personaName: "Libby" });
    expect(out.personaName).toBe("Libby");
    expect(out.voiceId).toBe("base");
    expect(out.startupCatchphrases).toBe(DEFAULT_PERSONA_GREETINGS);
  });
});

describe("shouldSuppressVoice", () => {
  test("suppresses headless and json/print runs", () => {
    expect(shouldSuppressVoice({ hasUI: false }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "json" }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, {})).toBe(false);
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, { ECHO_VOICE_SUPPRESS: "true" })).toBe(true);
  });
});

describe("pickStartupCatchphrase", () => {
  test("selects by injected random", () => {
    expect(pickStartupCatchphrase(["a", "b", "c"], () => 0)).toBe("a");
    expect(pickStartupCatchphrase(["a", "b", "c"], () => 0.999)).toBe("c");
  });
});

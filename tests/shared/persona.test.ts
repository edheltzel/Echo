import { describe, expect, test } from "bun:test";
import {
  applyPersonaOverride,
  booleanEnv,
  shouldSuppressVoice,
  type BaseVoiceConfig,
} from "../../shared/persona.ts";

function base(overrides: Partial<BaseVoiceConfig> = {}): BaseVoiceConfig {
  return {
    personaName: "Pi",
    voiceId: "pi",
    ...overrides,
  };
}

describe("booleanEnv", () => {
  test("undefined keeps the fallback", () => {
    expect(booleanEnv(undefined, true)).toBe(true);
    expect(booleanEnv(undefined, false)).toBe(false);
  });

  test("accepts the adapter true/false spellings", () => {
    expect(booleanEnv("1", false)).toBe(true);
    expect(booleanEnv("true", false)).toBe(true);
    expect(booleanEnv("yes", false)).toBe(true);
    expect(booleanEnv("on", false)).toBe(true);
    expect(booleanEnv("0", true)).toBe(false);
    expect(booleanEnv("false", true)).toBe(false);
    expect(booleanEnv("no", true)).toBe(false);
    expect(booleanEnv("off", true)).toBe(false);
  });

  test("unknown strings keep the fallback (narrower than parseEchoBoolean)", () => {
    expect(booleanEnv("y", false)).toBe(false);
    expect(booleanEnv("n", true)).toBe(true);
    expect(booleanEnv("", true)).toBe(true);
  });
});

describe("applyPersonaOverride", () => {
  test("set keys win; unset keys keep the base", () => {
    const cfg = base();
    const out = applyPersonaOverride(cfg, { personaName: "Echo", voiceId: "en-US-AndrewNeural" });
    expect(out.personaName).toBe("Echo");
    expect(out.voiceId).toBe("en-US-AndrewNeural");
  });

  test("preserves extra adapter fields on T", () => {
    const cfg = { ...base(), endpoint: "http://localhost:3246/notify", title: "Pi Notification" };
    const out = applyPersonaOverride(cfg, { personaName: "Echo" });
    expect(out.endpoint).toBe(cfg.endpoint);
    expect(out.title).toBe("Pi Notification");
    expect(out.personaName).toBe("Echo");
  });
});

describe("shouldSuppressVoice", () => {
  test("suppresses headless, json, and print runs", () => {
    expect(shouldSuppressVoice({ hasUI: false }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "json" }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "print" }, {})).toBe(true);
  });

  test("speaks in interactive run modes with a real UI", () => {
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, {})).toBe(false);
    expect(shouldSuppressVoice({ mode: "rpc", hasUI: true }, {})).toBe(false);
  });

  test("emergency suppression wins over an interactive UI", () => {
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, { ECHO_VOICE_SUPPRESS: "true" })).toBe(true);
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, { ATLAS_VOICE_SUPPRESS: "true" })).toBe(true);
  });
});

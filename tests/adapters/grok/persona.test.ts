import { describe, expect, test } from "bun:test";
import { applyPersonaOverride } from "../../../shared/persona.ts";
import {
  loadGrokVoiceConfig,
  loadProjectPersona,
} from "../../../adapters/grok/config.ts";

describe("Grok project daidentity", () => {
  test("defaults to the Grok persona when no daidentity is present", () => {
    const resolved = loadGrokVoiceConfig({}, undefined);
    expect(resolved.personaName).toBe("Grok");
    expect(resolved.voiceId).toBe("grok");
  });

  test("project daidentity overrides env defaults", () => {
    const files: Record<string, string> = {
      "/proj/.grok/settings.json": JSON.stringify({
        daidentity: {
          name: "Themis",
          voices: { main: { voiceId: "en-GB-LibbyNeural" } },
        },
      }),
    };
    const read = (path: string) => files[path] ?? null;
    const override = loadProjectPersona("/proj", read, "/home");
    expect(override).toEqual({
      personaName: "Themis",
      voiceId: "en-GB-LibbyNeural",
    });
    const base = loadGrokVoiceConfig({ ECHO_VOICE_PERSONA_NAME: "Grok" }, undefined);
    const resolved = applyPersonaOverride(base, override);
    expect(resolved.personaName).toBe("Themis");
    expect(resolved.voiceId).toBe("en-GB-LibbyNeural");
  });

  test("global-only daidentity applies when no project file", () => {
    const override = loadProjectPersona("/proj", (path) => (
      path === "/home/.grok/settings.json"
        ? JSON.stringify({ daidentity: { name: "GlobalGrok", voiceId: "en-US-AvaNeural" } })
        : null
    ), "/home");
    expect(override).toEqual({ personaName: "GlobalGrok", voiceId: "en-US-AvaNeural" });
  });

  test("project wins per key; unset project keys fall through to global", () => {
    const files: Record<string, string> = {
      "/home/.grok/settings.json": JSON.stringify({
        daidentity: {
          name: "GlobalGrok",
          voices: { main: { voiceId: "global-voice" } },
          startupCatchphrases: ["Global line."],
        },
      }),
      "/proj/.grok/settings.json": JSON.stringify({
        daidentity: { voices: { main: { voiceId: "en-US-GuyNeural" } } },
      }),
    };
    expect(loadProjectPersona("/proj", (path) => files[path] ?? null, "/home")).toEqual({
      personaName: "GlobalGrok",
      voiceId: "en-US-GuyNeural",
      startupCatchphrases: ["Global line."],
    });
  });
});

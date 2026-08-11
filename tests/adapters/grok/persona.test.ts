import { describe, expect, test } from "bun:test";
import {
  applyPersonaOverride,
  loadGrokVoiceConfig,
  loadProjectPersona,
} from "../../../adapters/grok/config.ts";

describe("Grok project daidentity", () => {
  test("project settings override env defaults", () => {
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
});

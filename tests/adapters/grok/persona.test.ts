import { describe, expect, test } from "bun:test";
import {
  applyPersonaOverride,
  loadGrokVoiceConfig,
  loadProjectPersona,
  type GrokVoiceConfig,
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
    const base = loadGrokVoiceConfig({ ECHO_VOICE_PERSONA_NAME: "Grok" }, undefined, "/tmp/echo-absent-home");
    const resolved = applyPersonaOverride(base, override);
    expect(resolved.personaName).toBe("Themis");
    expect(resolved.voiceId).toBe("en-GB-LibbyNeural");
  });

  test("defaults are independent of operator global daidentity", () => {
    const resolved = loadGrokVoiceConfig({}, undefined, "/tmp/echo-absent-home");
    expect(resolved.personaName).toBe("Grok");
    expect(resolved.voiceId).toBe("grok");
    expect(resolved.sayName).toBe(false);
  });

  test("project persona preserves a custom base greeting", () => {
    const base: GrokVoiceConfig = {
      endpoint: "http://voice.example/notify",
      title: "Grok Notification",
      startupCatchphrases: ["Pinned greeting."],
      personaName: "Grok",
      sayName: false,
      voiceId: "grok",
      voiceEnabled: true,
      greetOnSessionStart: false,
      speakCompletions: true,
    };
    const resolved = applyPersonaOverride(base, { personaName: "Themis", sayName: true });
    expect(resolved.startupCatchphrases).toBe(base.startupCatchphrases);
  });
});

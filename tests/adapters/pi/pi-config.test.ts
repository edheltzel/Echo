import { describe, expect, test } from "bun:test";
import { loadPiVoiceConfig, shouldSuppressVoice } from "../../../adapters/pi/config";

describe("Pi voice config", () => {
  test("uses safe defaults without host-specific settings", () => {
    const config = loadPiVoiceConfig({});
    expect(config.endpoint).toBe("http://localhost:8888/notify");
    expect(config.title).toBe("Pi Notification");
    expect(config.catchphrase).toBe("Pi session ready.");
    expect(config.voiceEnabled).toBe(true);
    expect(config.personaName).toBe("Pi");
  });

  test("defaults voice_id to the pi persona (distinct Pi voice, #76)", () => {
    // Resolves to agents.pi in core/voices.json (en-US-GuyNeural), not the identity default.
    expect(loadPiVoiceConfig({}).voiceId).toBe("pi");
    // Still overridable via the canonical env name.
    expect(loadPiVoiceConfig({ ECHO_VOICE_ID: "custom" }).voiceId).toBe("custom");
  });

  test("suppresses headless run modes (Pi subagents run `pi --mode json -p`)", () => {
    expect(shouldSuppressVoice({ hasUI: false }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "json" }, {})).toBe(true);
    expect(shouldSuppressVoice({ mode: "print" }, {})).toBe(true);
  });

  test("speaks in interactive run modes with a real UI", () => {
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, {})).toBe(false);
    expect(shouldSuppressVoice({ mode: "rpc", hasUI: true }, {})).toBe(false);
  });

  test("supports emergency suppression regardless of run mode", () => {
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, { ECHO_VOICE_SUPPRESS: "true" })).toBe(true);
  });

  test("reads canonical ECHO_* names first", () => {
    const config = loadPiVoiceConfig({
      ECHO_NOTIFY_URL: "http://echo.example/notify",
      ECHO_VOICE_TITLE: "Echo Title",
      ECHO_VOICE_ID: "voice-echo",
      ECHO_VOICE_PERSONA_NAME: "Echo",
    });
    expect(config.endpoint).toBe("http://echo.example/notify");
    expect(config.title).toBe("Echo Title");
    expect(config.voiceId).toBe("voice-echo");
    expect(config.personaName).toBe("Echo");
  });

  test("still honors deprecated legacy env names as silent fallbacks", () => {
    // Old ATLAS_VOICE_* names keep working when the canonical ECHO_* name is unset.
    const config = loadPiVoiceConfig({
      ATLAS_VOICE_NOTIFY_URL: "http://legacy.example/notify",
      ATLAS_VOICE_TITLE: "Legacy Title",
    });
    expect(config.endpoint).toBe("http://legacy.example/notify");
    expect(config.title).toBe("Legacy Title");
    // Convergence: VOICESYSTEM_VOICE_ID is the lowest-priority fallback for voiceId.
    expect(loadPiVoiceConfig({ VOICESYSTEM_VOICE_ID: "vs-id" }).voiceId).toBe("vs-id");
    // Canonical wins over a legacy name when both are present.
    expect(
      loadPiVoiceConfig({ ECHO_VOICE_ID: "echo-id", ATLAS_VOICE_ID: "atlas-id" }).voiceId,
    ).toBe("echo-id");
    // Persona default is unchanged when no override is set.
    expect(loadPiVoiceConfig({}).personaName).toBe("Pi");
    // Emergency suppression also honors the legacy name.
    expect(shouldSuppressVoice({ mode: "tui", hasUI: true }, { ATLAS_VOICE_SUPPRESS: "true" })).toBe(true);
  });
});

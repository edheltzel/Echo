import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STARTUP_CATCHPHRASES,
  loadPiVoiceConfig,
  pickStartupCatchphrase,
  shouldSuppressVoice,
} from "../../../adapters/pi/config";
import { edgeRateFromSpeed } from "../../../core/edge-rate";
import { loadEchoEnvironment } from "../../../shared/echo-env";

describe("Pi voice config", () => {
  test("uses safe defaults without host-specific settings", () => {
    const config = loadPiVoiceConfig({});
    expect(config.endpoint).toBe("http://localhost:8888/notify");
    expect(config.title).toBe("Pi Notification");
    expect(config.startupCatchphrases).toEqual(DEFAULT_STARTUP_CATCHPHRASES);
    expect(config.voiceEnabled).toBe(true);
    expect(config.personaName).toBe("Pi");
  });

  test("loads persistent adapter identity from Echo config with process env precedence", () => {
    const home = mkdtempSync(join(tmpdir(), "echo-pi-config-"));
    try {
      const configDir = join(home, ".config", "echo");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, ".env"),
        'ECHO_VOICE_PERSONA_NAME=Atlas\nECHO_VOICE_CATCHPHRASE="Atlas online and standing by."\n',
      );

      const fromFile = loadPiVoiceConfig(loadEchoEnvironment({}, home));
      expect(fromFile.personaName).toBe("Atlas");
      expect(fromFile.startupCatchphrases).toEqual(["Atlas online and standing by."]);

      const fromProcess = loadPiVoiceConfig(loadEchoEnvironment(
        { ECHO_VOICE_PERSONA_NAME: "Override" },
        home,
      ));
      expect(fromProcess.personaName).toBe("Override");
      expect(fromProcess.startupCatchphrases).toEqual(["Atlas online and standing by."]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("default greeting pool has variety and no hardcoded persona name (#81)", () => {
    // A pool of one would make the random pick pointless; a persona name would
    // violate the neutral-default-identity rule (Pi and omp share this adapter).
    expect(DEFAULT_STARTUP_CATCHPHRASES.length).toBeGreaterThan(1);
    for (const phrase of DEFAULT_STARTUP_CATCHPHRASES) {
      expect(phrase.trim().length).toBeGreaterThan(0);
      expect(phrase).not.toMatch(/\bPi\b/i);
    }
  });

  test("catchphrase env override pins the greeting to a single line (#81)", () => {
    expect(loadPiVoiceConfig({ ECHO_VOICE_CATCHPHRASE: "Pinned line." }).startupCatchphrases)
      .toEqual(["Pinned line."]);
    // Legacy name still works as a silent fallback; canonical wins when both are set.
    expect(loadPiVoiceConfig({ ATLAS_VOICE_CATCHPHRASE: "Legacy line." }).startupCatchphrases)
      .toEqual(["Legacy line."]);
    expect(
      loadPiVoiceConfig({ ECHO_VOICE_CATCHPHRASE: "Echo.", ATLAS_VOICE_CATCHPHRASE: "Atlas." })
        .startupCatchphrases,
    ).toEqual(["Echo."]);
  });

  test("pickStartupCatchphrase selects uniformly by the injected random (#81)", () => {
    const pool = ["a", "b", "c"];
    expect(pickStartupCatchphrase(pool, () => 0)).toBe("a");
    expect(pickStartupCatchphrase(pool, () => 0.5)).toBe("b");
    expect(pickStartupCatchphrase(pool, () => 0.999)).toBe("c");
    // A pinned pool (env override) always yields its single line.
    expect(pickStartupCatchphrase(["only"], Math.random)).toBe("only");
  });

  test("consecutive session starts can greet with different lines (#81)", () => {
    // Probabilistic but effectively certain: 200 real-random draws from a pool
    // of N>1 collapse to one distinct value with probability N^(1-200).
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      seen.add(pickStartupCatchphrase(DEFAULT_STARTUP_CATCHPHRASES));
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  test("defaults voice_id to the pi persona (distinct Pi voice, #76)", () => {
    // Resolves to agents.pi in core/voices.json (en-GB-RyanNeural), not the identity default.
    expect(loadPiVoiceConfig({}).voiceId).toBe("pi");
    // Still overridable via the canonical env name.
    expect(loadPiVoiceConfig({ ECHO_VOICE_ID: "custom" }).voiceId).toBe("custom");
  });

  test("default voice_id resolves against core/voices.json agents (cross-boundary contract, #76)", async () => {
    // Renaming/removing the agents.pi entry would silently revert Pi to the identity
    // voice at runtime while literal-string tests stay green — bind the two halves.
    const voices = await Bun.file(new URL("../../../core/voices.json", import.meta.url)).json();
    const defaultVoiceId = loadPiVoiceConfig({}).voiceId!;
    expect(Object.keys(voices.agents)).toContain(defaultVoiceId);
    expect(voices.agents[defaultVoiceId].edgetts.voice).toBe("en-GB-RyanNeural");
    // Speed 0.92 must convert to edge-tts rate -8% exactly (#81) — bind the data
    // to the daemon's conversion so a speed edit can't silently change the rate.
    expect(voices.agents[defaultVoiceId].edgetts.speed).toBe(0.92);
    expect(edgeRateFromSpeed(voices.agents[defaultVoiceId].edgetts.speed)).toBe("-8%");
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

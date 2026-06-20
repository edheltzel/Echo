import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("core server route contract source", () => {
  const server = readFileSync("core/server.ts", "utf8");

  test("keeps neutral default title in core with legacy override outside core", () => {
    expect(server).toContain('DEFAULT_NOTIFICATION_TITLE = process.env.VOICESYSTEM_DEFAULT_TITLE || "Voice Notification"');
    expect(server).not.toContain("PAI Notification");

    const legacyWrapper = readFileSync("claudecode/.claude/PAI/USER/Voice/server.ts", "utf8");
    expect(legacyWrapper).toContain('process.env.VOICESYSTEM_DEFAULT_TITLE ??= "PAI Notification"');
  });

  test("unsupported POST routes fail explicitly instead of returning generic 200", () => {
    expect(server).toContain("Unsupported endpoint");
    expect(server).toContain("supported_endpoints");
    expect(server).toContain("status: 404");
  });

  test("audio temp files use user-owned cache directories, not world-writable /tmp paths", () => {
    expect(server).toContain("AUDIO_CACHE_DIR");
    expect(server).toContain("mkdtempSync");
    expect(server).not.toContain("/tmp/voice");
    expect(server).not.toContain("/tmp/voiceserver");
  });

  test("voice resolver honors per-agent edgetts mapping in both tiers", () => {
    // Tier 1 (caller-supplied settings) and Tier 2 (config-resolved) both
    // populate providerVoice from the edgetts mapping.
    expect(server).toContain("providerName === 'edgetts' && voiceMapping?.edgetts");
    expect(server).toContain("providerName === 'edgetts' && voiceMapping.edgetts");
    expect(server).toContain("voiceMapping.edgetts.voice");
  });

  test("edge provider derives its rate from the resolved speed via edgeRateFromSpeed", () => {
    expect(server).toContain("edgeRateFromSpeed(settings?.speed, voicesConfig.providers.edgetts?.rate)");
  });

  // --- issue #25: edge-tts fallback tuning (retry + attribution + env knobs) ---

  test("edge-tts synth timeout is env-configurable (VOICESYSTEM_EDGETTS_TIMEOUT_MS, default 15000)", () => {
    expect(server).toContain('parseInt(process.env.VOICESYSTEM_EDGETTS_TIMEOUT_MS || "15000")');
  });

  test("edge-tts retries transient synthesis failures before recording a provider failure", () => {
    expect(server).toContain("EDGETTS_SYNTH_RETRIES");
    expect(server).toContain("synthesizeOnce");
    expect(server).toContain("synth retry");
  });

  test("a playback failure does NOT count against the edge-tts breaker", () => {
    // Attribution fix B: synthesis (provider) and playback (local) are
    // separated. recordProviderFailure('edgetts') must be reachable ONLY from
    // the exhausted-synthesis path — never from the playback catch.
    const failureCalls = server.split("recordProviderFailure('edgetts')").length - 1;
    expect(failureCalls).toBe(1);
    expect(server).toContain("playback failed via");
    // The playback catch returns false without touching the breaker.
    expect(server).toMatch(/catch \(playError[\s\S]*?return false;/);
  });

  test("/health reports the edge-tts circuit breaker (previously omitted)", () => {
    expect(server).toContain("circuitBreakers.edgetts.isOpen");
    expect(server).toContain("circuitBreakers.edgetts.failures");
  });
});

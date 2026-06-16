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
});

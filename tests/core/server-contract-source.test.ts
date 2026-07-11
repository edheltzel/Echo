import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

describe("core server route contract source", () => {
  const server = readFileSync("core/server.ts", "utf8");

  test("core config reads are import-pure — no process.env writes", () => {
    // Hydrating process.env from the user's env files at import time leaked
    // the operator's ECHO_VOICE_* identity into same-process adapter code and
    // its tests (the pi-adapter "Atlas" pollution; an AGENTS.md #47 class
    // file-order hazard). Core reads config through resolveEchoEnv instead.
    // Catches plain/compound assignment (=, ??=, ||=, &&=, +=), Object.assign
    // into process.env, and delete — not just `=` (review: regex hardening).
    const assignment = /(process\.env(\.\w+|\[[^\]]*\])\s*(\?\?=|\|\|=|&&=|\+=|=(?![=>]))|Object\.assign\(\s*process\.env|delete\s+process\.env)/;
    for (const file of readdirSync("core").filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(`core/${file}`, "utf8");
      expect({ file, writes: assignment.test(src) }).toEqual({ file, writes: false });
    }
    expect(server).toContain('resolveEchoEnv("PORT")');
  });

  test("keeps neutral default title in core, read from canonical ECHO_* with legacy fallback", () => {
    expect(server).toContain('DEFAULT_NOTIFICATION_TITLE = resolveEchoEnv("ECHO_DEFAULT_TITLE") ?? resolveEchoEnv("VOICESYSTEM_DEFAULT_TITLE") ?? "Voice Notification"');
    expect(server).not.toContain("PAI Notification");
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

  test("edge-tts synth timeout is env-configurable (ECHO_EDGETTS_TIMEOUT_MS, default 15000)", () => {
    expect(server).toContain('parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_TIMEOUT_MS"), 15000, 1)');
  });

  test("edge-tts retries transient synthesis failures before recording a provider failure", () => {
    expect(server).toContain("EDGETTS_SYNTH_RETRIES");
    expect(server).toContain("synthesizeOnce");
    expect(server).toContain("synth retry");
  });

  test("a playback failure does NOT count against the edge-tts breaker", () => {
    // Attribution fix B: synthesis (provider) and playback (local) are
    // separated. The playback catch returns false WITHOUT recording a provider
    // failure — only synth-side paths touch the breaker.
    const playbackCatch = server.match(/catch \(playError[\s\S]*?\n {6}\}/);
    expect(playbackCatch).not.toBeNull();
    expect(playbackCatch![0]).toContain("return false;");
    expect(playbackCatch![0]).not.toContain("recordProviderFailure");
    expect(server).toContain("playback failed via");
  });

  test("/health reports the edge-tts circuit breaker (previously omitted)", () => {
    expect(server).toContain("circuitBreakers.edgetts.isOpen");
    expect(server).toContain("circuitBreakers.edgetts.failures");
  });

  test("numeric env overrides are bounded — a bad value cannot mask an outage", () => {
    // timeout/backoff floor 1 (0ms timeout = instant fail), retries floor 0.
    expect(server).toContain('parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_TIMEOUT_MS"), 15000, 1)');
    expect(server).toContain('parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_SYNTH_RETRIES") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_SYNTH_RETRIES"), 1, 0)');
    expect(server).toContain('parseBoundedInt(resolveEchoEnv("ECHO_EDGETTS_SYNTH_BACKOFF_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_SYNTH_BACKOFF_MS"), 250, 1)');
    // Raw parseInt on these would let NaN/0/negative through.
    expect(server).not.toContain('parseInt(resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_MS")');
  });

  test("legacy VOICESYSTEM_* env names are retained in source as silent fallbacks", () => {
    // The canonical ECHO_* name is read first; the old name stays as the `??` tail.
    expect(server).toContain('resolveEchoEnv("ECHO_EDGETTS_TIMEOUT_MS") ?? resolveEchoEnv("VOICESYSTEM_EDGETTS_TIMEOUT_MS")');
    expect(server).toContain('resolveEchoEnv("ECHO_RESOLUTION_LOG") ?? resolveEchoEnv("VOICESYSTEM_RESOLUTION_LOG")');
  });

  test("edge-tts success requires a synthesis attempt to have actually run", () => {
    // Defense-in-depth: a degenerate zero-iteration loop must record a failure,
    // not a false success.
    expect(server).toMatch(/if \(!tmp\)[\s\S]*?recordProviderFailure\('edgetts'\)/);
  });
});

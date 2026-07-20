// A voice_id that is a literal edge-tts voice name (not a voices.json agent key)
// must be honored by the edge provider, NOT degraded to the default voice. This
// is the daemon half of the project-persona voice override (#111): a project sets
// daidentity.voices.main.voiceId = "en-US-AndrewNeural" and the hook sends it as
// voice_id — with no core/voices.json entry for it. Before the fix, getVoiceMapping
// returned null and the request fell to Tier-3 defaults (silent wrong voice); the
// raw pass-through existed for elevenlabs only.
// PORT=0 binds an ephemeral port so importing the daemon never collides with a
// running :8888. Must be set BEFORE the daemon module evaluates — hence the
// dynamic import below (a static import is hoisted above this assignment).
process.env.PORT = "0";

import { describe, expect, test } from "bun:test";

const { classifyResolution, getVoiceMapping, looksLikeEdgeVoice } = await import("../../core/server.ts");

describe("looksLikeEdgeVoice", () => {
  test("matches common edge-tts voice names", () => {
    for (const v of [
      "en-US-AndrewNeural",
      "en-GB-RyanNeural",
      "en-AU-WilliamNeural",
      "en-US-AndrewMultilingualNeural",
      "zh-CN-liaoning-XiaobeiNeural",
    ]) {
      expect(looksLikeEdgeVoice(v)).toBe(true);
    }
  });

  test("rejects non-edge identifiers (agent keys, ElevenLabs ids, junk)", () => {
    for (const v of ["themis", "AyCt0WmAXUcPJR11zeeP", "en-US-Andrew", "", null, undefined]) {
      expect(looksLikeEdgeVoice(v)).toBe(false);
    }
  });
});

describe("getVoiceMapping — a raw edge voice name is not a mapping", () => {
  test("returns null for an edge-tts voice name (no voices.json entry)", () => {
    // This is exactly why the pass-through is needed: no mapping → Tier-3 default
    // unless the edge provider is told to speak the literal name.
    expect(getVoiceMapping("en-US-AndrewNeural")).toBeNull();
  });
});

describe("classifyResolution — explicit edge voice is honest, not a fallback", () => {
  test("edge voice name + null mapping → 'edgetts-explicit'", () => {
    expect(classifyResolution("en-US-AndrewNeural", null).resolution).toBe("edgetts-explicit");
  });

  test("genuinely unresolvable id + null mapping → 'fallback'", () => {
    const r = classifyResolution("AyCt0WmAXUcPJR11zeeP", null);
    expect(r.resolution).toBe("fallback");
    expect(r.reason).toContain("did not match");
  });

  test("no voice_id → identity-default (unchanged)", () => {
    expect(classifyResolution(null, null).resolution).toBe("identity-default");
  });
});

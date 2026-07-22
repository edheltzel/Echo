// Single owner of the edge-tts voice-name grammar.
//
// The daemon (`core/server.ts`) and the adapters' `/echo-voice` scaffold both have to
// answer "is this string an edge-tts voice name?" — the daemon to decide whether a
// caller-supplied `voice_id` is a literal provider voice, the scaffold to reject a typo
// before writing it into a project config. That is ONE invariant, so it lives in ONE
// place. `shared/` sits below both (core imports it, adapters import it, it imports
// neither), which makes it the only module both sides can legally reach.
//
// The scaffold validates offline, at command time, with the daemon possibly down — so
// this is deliberately a shared module and not a daemon HTTP lookup.

// An edge-tts voice name (e.g. "en-US-AndrewNeural", "en-GB-RyanNeural",
// "zh-CN-liaoning-XiaobeiNeural"). A caller may pass one directly as voice_id
// (e.g. a project persona's configured voice) without a voices.json agent entry;
// the edgetts provider then speaks in it literally. Anchored on the locale prefix
// + `Neural` suffix so a stray ElevenLabs id or agent key never matches.
const EDGE_VOICE_RE = /^[a-z]{2,3}-[A-Z]{2}-[A-Za-z-]+Neural$/;

export function looksLikeEdgeVoice(identifier: string | null | undefined): boolean {
  return !!identifier && EDGE_VOICE_RE.test(identifier);
}

// Notify density for Echo: VoiceLayer announce/brief/consult/think, minus
// converse (two-way ask is a different product) and minus think-log / rate
// auto-slow. Both the daemon and the adapters need the same four names, so the
// mapping lives here once. `shared/` sits below both (core imports it, adapters
// import it, it imports neither).
//
// Omitted speak_mode keeps today's density. Adapters fill a mode when they shape
// a notify; think is never inferred (silence is already `voice_enabled: false`).

export const SPEAK_MODES = ["announce", "brief", "consult", "think"] as const;
export type SpeakMode = (typeof SPEAK_MODES)[number];

/** VoiceLayer auto-detect: longer than this is a brief, not a ping. */
export const BRIEF_CHAR_THRESHOLD = 280;

/** Density speed multipliers, applied after persona/pass-through resolution. */
export const SPEAK_MODE_SPEED: Record<Exclude<SpeakMode, "think">, number> = {
  announce: 1.10,
  brief: 0.90,
  consult: 1.05,
};

export function isSpeakMode(value: string): value is SpeakMode {
  return (SPEAK_MODES as readonly string[]).includes(value);
}

export function parseSpeakMode(
  value: unknown,
): { ok: true; mode: SpeakMode | undefined } | { ok: false } {
  if (value === undefined || value === null || value === "") {
    return { ok: true, mode: undefined };
  }
  if (typeof value !== "string") return { ok: false };
  const normalized = value.trim().toLowerCase();
  if (isSpeakMode(normalized)) return { ok: true, mode: normalized };
  return { ok: false };
}

/** Adapter shaping. think is explicit-only so a "note:" line cannot go silent. */
export function detectSpeakMode(message: string): Exclude<SpeakMode, "think"> {
  const trimmed = message.trim();
  if (/\?/.test(trimmed) || /\babout to\b/i.test(trimmed)) return "consult";
  if (trimmed.length > BRIEF_CHAR_THRESHOLD) return "brief";
  return "announce";
}

export function applySpeakModeSpeed(baseSpeed: number, mode: SpeakMode | undefined): number {
  if (!mode || mode === "think") return baseSpeed;
  return baseSpeed * SPEAK_MODE_SPEED[mode];
}

export function voiceEnabledForSpeakMode(
  mode: SpeakMode | undefined,
  voiceEnabled: boolean,
): boolean {
  return mode === "think" ? false : voiceEnabled;
}

/** Fill speak_mode only when the caller omitted it. */
export function withDetectedSpeakMode<T extends { message: string; speak_mode?: unknown }>(
  payload: T,
): T & { speak_mode: SpeakMode } {
  const parsed = parseSpeakMode(payload.speak_mode);
  if (parsed.ok && parsed.mode) return { ...payload, speak_mode: parsed.mode };
  return { ...payload, speak_mode: detectSpeakMode(payload.message) };
}

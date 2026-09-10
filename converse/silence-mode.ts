// VoiceLayer silence-mode names, mapped onto sox trailing-silence windows.
//
// The live endpointer is sox's `silence` effect (see converse/capture.ts), not
// Silero/onnxruntime. These durations match VoiceLayer's documented
// quick / standard / thoughtful windows (0.5s / 1.5s / 2.5s) in
// docs/plans/support/voiceask-scoping/vl-anatomy.md.

export const SILENCE_MODES = ["quick", "standard", "thoughtful"] as const;

export type SilenceMode = (typeof SILENCE_MODES)[number];

/** Trailing silence that ends a capture, in milliseconds. */
export const SILENCE_MODE_MS: Record<SilenceMode, number> = {
  quick: 500,
  standard: 1_500,
  thoughtful: 2_500,
};

/**
 * Today's `ECHO_CONVERSE_SILENCE_MS` default is 1500ms, which is VoiceLayer
 * `standard`. Omitting `silence_mode` keeps that window.
 */
export const DEFAULT_SILENCE_MODE: SilenceMode = "standard";

export function isSilenceMode(value: unknown): value is SilenceMode {
  return value === "quick" || value === "standard" || value === "thoughtful";
}

export function parseSilenceMode(raw: string | undefined): SilenceMode | undefined {
  return isSilenceMode(raw) ? raw : undefined;
}

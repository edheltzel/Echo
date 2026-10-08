// Bounded in-memory ring of lines that actually reached the speaker.
//
// Replay (FM-449) re-speaks from this ring. It is not a second play queue:
// muted, capture-held, dropped, and voice-disabled lines are never stored, so
// there is nothing later to replay (http-api: "Muted lines are not held for
// later replay"). Process-local on purpose — a restart starts empty; the TTS
// cache already covers repeated synthesis.

import type { SpeakMode } from "../shared/speak-mode";

export const SPEAK_HISTORY_CAPACITY = 10;
export const REPLAY_DEFAULT_N = 1;
export const REPLAY_MAX_N = SPEAK_HISTORY_CAPACITY;

export type SpokenVoiceSettings = {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  speed?: number;
  use_speaker_boost?: boolean;
};

export type SpokenLine = {
  message: string;
  voiceId: string | null;
  voiceSettings: SpokenVoiceSettings | null;
  speakMode?: SpeakMode;
};

const ring: SpokenLine[] = [];

export function recordSpokenLine(line: SpokenLine): void {
  ring.push(line);
  while (ring.length > SPEAK_HISTORY_CAPACITY) ring.shift();
}

/** Oldest-first among the last `n` spoken lines (n already validated). */
export function lastSpokenLines(n: number): SpokenLine[] {
  if (n <= 0 || ring.length === 0) return [];
  return ring.slice(-n);
}

export function spokenLineCount(): number {
  return ring.length;
}

/** Test seam: the daemon is a process singleton, so tests reset the ring. */
export function clearSpeakHistory(): void {
  ring.length = 0;
}

export type ReplayNResult =
  | { ok: true; n: number }
  | { ok: false; message: string };

const N_ERROR = `n must be an integer from 1 to ${REPLAY_MAX_N}`;

export function parseReplayN(value: unknown): ReplayNResult {
  if (value === undefined) return { ok: true, n: REPLAY_DEFAULT_N };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > REPLAY_MAX_N) {
    return { ok: false, message: N_ERROR };
  }
  return { ok: true, n: value };
}

/** Empty body = default N (one-keystroke replay of the last line). */
export function parseReplayBody(text: string): ReplayNResult {
  if (text.trim() === "") return { ok: true, n: REPLAY_DEFAULT_N };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, message: "Invalid JSON body" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, message: "Invalid body" };
  }
  return parseReplayN((data as { n?: unknown }).n);
}

// =============================================================================
// Audio Lifecycle Log — host-neutral playback observability
// =============================================================================
//
// One structured JSONL event per spoken /notify, recording the full audio
// lifecycle: synthesis timing, the clip's real duration, actual playback
// wall-time, and how playback ended. This is the instrument that makes
// truncation measurable — a clip that plays short shows play_time < clip
// duration, where before nothing recorded either number.
//
// Mirrors the resolution-log design in core/server.ts (writeResolutionEvent):
// a single size-capped JSONL file, oldest whole lines pruned on write, all
// failures swallowed so logging can NEVER break a /notify.
//
// Path: ~/.agents/Echo/audio-lifecycle.jsonl (created 0700), overridable via
// ECHO_AUDIO_LIFECYCLE_LOG. User-owned, never /tmp, never the repo. Resolved at
// write time (not frozen at module load) so a process setting the override
// after import — e.g. a test — writes to the intended path regardless of import
// order. Host-neutral: no host-adapter knowledge here.
// =============================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseBoundedInt, resolveEchoEnv } from './env';

// How playback ended (KTD6): clean exit → completed; the process-timeout kill →
// timed-out; non-zero exit / signal → killed; spawn or other failure → error.
export type PlaybackExitReason = 'completed' | 'timed-out' | 'killed' | 'error';

// How the play-queue disposed of the line (Phase 2 / R7): reached the player
// (`played`), dropped without playing (`dropped-stale` — either it waited
// past the age cap at dequeue, or the depth cap evicted it at enqueue;
// `disposition_reason` discriminates), or replaced by a newer same-session
// line while queued (`superseded`).
export type AudioDisposition = 'played' | 'dropped-stale' | 'superseded';

export interface AudioLifecycleEvent {
  ts: string;
  session_id: string | null;
  request_id: string | null;
  message_chars: number;
  provider: string;              // provider that spoke, or 'none'
  synth_duration_ms: number | null;
  clip_duration_s: number | null; // real audio length (afinfo), null if unavailable
  play_started_at: string | null;
  play_ended_at: string | null;
  play_time_ms: number | null;    // actual playback wall-time
  exit_reason: PlaybackExitReason | null;
  muted: boolean;
  success: boolean;
  // Optional so pre-Phase-2 rows stay valid: readers treat an absent
  // disposition as 'played'. Dropped/superseded rows carry the reason and no
  // playback metrics.
  disposition?: AudioDisposition;
  disposition_reason?: string;
}

export function resolveAudioLifecycleLogPath(): string {
  return resolveEchoEnv('ECHO_AUDIO_LIFECYCLE_LOG') ?? join(homedir(), '.agents', 'Echo', 'audio-lifecycle.jsonl');
}

// ~1MB cap (floor 1KB). Override via ECHO_AUDIO_LIFECYCLE_LOG_MAX_BYTES.
// Live process env only (frozen at module load): this module initializes
// before the daemon's config layer, matching the pre-Phase-2 behavior.
export const AUDIO_LIFECYCLE_LOG_MAX_BYTES = parseBoundedInt(process.env.ECHO_AUDIO_LIFECYCLE_LOG_MAX_BYTES, 1_000_000, 1024);

// Append one event, then roll the file back under the cap. Best-effort: all
// failures are swallowed so logging can never break a notification.
export function writeAudioLifecycleEvent(
  event: AudioLifecycleEvent,
  path: string = resolveAudioLifecycleLogPath(),
  maxBytes: number = AUDIO_LIFECYCLE_LOG_MAX_BYTES,
): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(path, JSON.stringify(event) + '\n');
    pruneAudioLifecycleLog(path, maxBytes);
  } catch {
    // swallow — diagnostics logging must never break a notification
  }
}

// Rolling prune: if the file exceeds maxBytes, drop the oldest whole lines until
// it fits, always keeping the newest line. O(n) in line count.
function pruneAudioLifecycleLog(path: string, maxBytes: number): void {
  if (statSync(path).size <= maxBytes) return;
  const encoded = readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l + '\n');
  const sizes = encoded.map((s) => Buffer.byteLength(s));
  let total = sizes.reduce((a, b) => a + b, 0);
  let start = 0;
  while (start < encoded.length - 1 && total > maxBytes) {
    total -= sizes[start];
    start++;
  }
  writeFileSync(path, encoded.slice(start).join(''));
}

// Pure: derive the exit reason from structured playback outcome signals (KTD6).
export function classifyPlaybackOutcome(opts: {
  timedOut: boolean;
  errored: boolean;
  exitCode: number | null;
}): PlaybackExitReason {
  if (opts.timedOut) return 'timed-out';
  if (opts.exitCode === 0) return 'completed';
  if (opts.errored) return 'error';
  return 'killed';
}

// Pure: turn a waitForProcess rejection message into the structured signals
// classifyPlaybackOutcome consumes. waitForProcess throws
// "<label> timed out after <n>ms" on the timeout kill and
// "<label> exited with code <n>" on a non-zero exit; anything else is a genuine
// spawn/runtime error.
export function classifyPlaybackError(message: string): { timedOut: boolean; exitCode: number | null; errored: boolean } {
  if (/timed out/i.test(message)) return { timedOut: true, exitCode: null, errored: false };
  const m = message.match(/exited with code (-?\d+)/i);
  if (m) return { timedOut: false, exitCode: parseInt(m[1], 10), errored: false };
  return { timedOut: false, exitCode: null, errored: true };
}

// Pure: parse a clip's duration in seconds from `afinfo` stdout, or null when
// the expected line is absent/unparseable. afinfo prints "estimated duration:
// <float> sec".
export function parseAfinfoDuration(stdout: string): number | null {
  const m = stdout.match(/estimated duration:\s*([\d.]+)\s*sec/i);
  if (!m) return null;
  const secs = parseFloat(m[1]);
  return Number.isFinite(secs) ? secs : null;
}

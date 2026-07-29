// Speaking the question through core, and knowing when it has finished.
//
// Converse writes no TTS code: the question goes out as an ordinary POST
// /notify, so it rides the whole existing provider chain, cache, pronunciation
// pass and play queue. What converse has to add is the part /notify cannot give
// it - notify acks 202 on receipt, so the caller never learns when the line
// actually played, and the microphone must not open until it has.
//
// Two constraints shape the waiting strategy, and the second one is easy to miss:
//
//  * GET /health shares /notify's rate-limit bucket (10 requests per minute per
//    client). Polling in a tight loop would 429 itself and, worse, starve the
//    host's own notifications - a dropped notification is the failure the
//    bucket exists to prevent. So converse estimates the speech duration from
//    the question's length, sleeps that out, and only then polls sparsely.
//  * The question is posted under a session id unique to the turn. The play
//    queue coalesces newest-per-session, so sharing the host's session id would
//    let a later host line replace the question - core would then stay silent
//    while the caller happily recorded.
//
// Known residual, called out in the plan and not fixed here: a question dropped
// by the queue's age cap is indistinguishable from one that played, because
// telling them apart needs a per-request completion signal that would change the
// /notify contract. The wait is bounded and the outcome is reported instead.

import type { CoreHealthSnapshot } from "./types.ts";

/** edge-tts speaks near 14 characters a second; the constant covers synthesis and playback start. */
const SPEECH_OVERHEAD_MS = 1_200;
const MS_PER_CHARACTER = 70;
const DRAIN_POLL_INTERVAL_MS = 1_500;
const DRAIN_MAX_POLLS = 6;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

const realSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function estimateSpeechMs(question: string): number {
  return SPEECH_OVERHEAD_MS + question.length * MS_PER_CHARACTER;
}

/** The play queue's session key for a turn: unique, so the question cannot be coalesced away. */
export function turnSessionId(turnId: string): string {
  return `converse:${turnId}`;
}

export async function readCoreHealth(
  coreBaseUrl: string,
  fetchImpl: FetchLike,
): Promise<CoreHealthSnapshot | null> {
  try {
    const response = await fetchImpl(`${coreBaseUrl}/health`);
    if (!response.ok) return null;
    return (await response.json()) as CoreHealthSnapshot;
  } catch {
    return null;
  }
}

export type CoreAssessment =
  | { ok: true; capture_state_path: string }
  | { ok: false; code: "core_unreachable" | "core_muted" | "capture_guard_disabled"; detail: string }
  | { ok: false; code: "microphone_busy"; detail: string };

/**
 * Decide whether a turn can start at all. Each refusal below is a case where the
 * turn would otherwise record into a silence the human never heard, or record
 * with no interlock protecting the recording.
 */
export function assessCore(health: CoreHealthSnapshot | null): CoreAssessment {
  if (health === null) {
    return { ok: false, code: "core_unreachable", detail: "core did not answer GET /health" };
  }
  if (health.mute?.muted) {
    return {
      ok: false,
      code: "core_muted",
      detail: "core is muted, so the question would never be heard. Run `cli/echo mute off` first.",
    };
  }
  const capturePath = health.capture_guard?.path;
  if (typeof capturePath !== "string" || capturePath.length === 0) {
    return {
      ok: false,
      code: "capture_guard_disabled",
      detail:
        "core reports no capture-state path (ECHO_CAPTURE_STATE_PATH is empty), " +
        "so nothing would stop core speaking into the recording.",
    };
  }
  if (health.capture_guard.state !== "idle") {
    return {
      ok: false,
      code: "microphone_busy",
      detail: `another capture is ${health.capture_guard.state}`,
    };
  }
  return { ok: true, capture_state_path: capturePath };
}

export interface SpeakQuestionOptions {
  coreBaseUrl: string;
  question: string;
  turnId: string;
  voiceId?: string;
  title?: string;
  source?: string;
  fetchImpl: FetchLike;
}

/**
 * Post the question. `voice_enabled` is forced on: a silent question would leave
 * the human recorded against a prompt they never heard.
 */
export async function speakQuestion(options: SpeakQuestionOptions): Promise<{ status: number; body: string }> {
  const response = await options.fetchImpl(`${options.coreBaseUrl}/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: options.question,
      title: options.title ?? "Echo asks",
      voice_enabled: true,
      voice_id: options.voiceId,
      session_id: turnSessionId(options.turnId),
      source: options.source ?? "converse",
    }),
  });
  return { status: response.status, body: await response.text() };
}

export interface DrainOptions {
  coreBaseUrl: string;
  estimateMs: number;
  fetchImpl: FetchLike;
  sleep?: SleepLike;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface DrainReport {
  drained: boolean;
  waited_ms: number;
  polls: number;
}

function queueIsIdle(health: CoreHealthSnapshot): boolean {
  return health.play_queue.depth === 0 && health.play_queue.in_flight_ms === null;
}

/**
 * Wait for core's play queue to go idle: sleep out the estimated speech first,
 * then poll. The queue holds the job from the moment /notify acks, so an idle
 * reading after the estimate means the question is done rather than not started.
 */
export async function waitForPlaybackDrain(options: DrainOptions): Promise<DrainReport> {
  const sleep = options.sleep ?? realSleep;
  const interval = options.pollIntervalMs ?? DRAIN_POLL_INTERVAL_MS;
  const maxPolls = options.maxPolls ?? DRAIN_MAX_POLLS;

  await sleep(options.estimateMs);
  let waited = options.estimateMs;

  for (let poll = 1; poll <= maxPolls; poll++) {
    const health = await readCoreHealth(options.coreBaseUrl, options.fetchImpl);
    // A null reading is a 429 or a blip, not evidence the queue is empty. Keep
    // waiting: opening the microphone on a guess is the expensive mistake.
    if (health !== null && queueIsIdle(health)) {
      return { drained: true, waited_ms: waited, polls: poll };
    }
    if (poll === maxPolls) return { drained: false, waited_ms: waited, polls: poll };
    await sleep(interval);
    waited += interval;
  }
  return { drained: false, waited_ms: waited, polls: maxPolls };
}

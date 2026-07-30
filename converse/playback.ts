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

// Backoff rather than a fixed cadence, and this is a budget decision as much as
// a latency one. Core's /health shares its /notify bucket at ten requests a
// minute per client, so one ask can afford about three or four core requests
// before it starts eating the host's own notification budget. Early polls stay
// close together (the human should not sit in silence after the question), then
// widen fast so a slow synthesis costs one more request, not six.
const DRAIN_BACKOFF_MS = [750, 1_250, 2_000, 3_500] as const;

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

/**
 * A rate-limited read is reported separately from an unreachable one. They look
 * identical over the wire but mean opposite things to an operator: one is "the
 * daemon is down", the other is "you asked twice inside a minute".
 */
export type CoreHealthRead =
  | { status: "ok"; health: CoreHealthSnapshot }
  | { status: "rate_limited" }
  | { status: "unreachable" };

export async function readCoreHealth(coreBaseUrl: string, fetchImpl: FetchLike): Promise<CoreHealthRead> {
  try {
    const response = await fetchImpl(`${coreBaseUrl}/health`);
    if (response.status === 429) return { status: "rate_limited" };
    if (!response.ok) return { status: "unreachable" };
    return { status: "ok", health: (await response.json()) as CoreHealthSnapshot };
  } catch {
    return { status: "unreachable" };
  }
}

export type CoreAssessment =
  | { ok: true; capture_state_path: string }
  | {
      ok: false;
      code:
        | "core_unreachable"
        | "core_rate_limited"
        | "core_muted"
        | "capture_guard_disabled"
        | "capture_path_mismatch";
      detail: string;
    }
  | { ok: false; code: "microphone_busy"; detail: string };

/**
 * Decide whether a turn can start at all. Each refusal below is a case where the
 * turn would otherwise record into a silence the human never heard, or record
 * with no interlock protecting the recording.
 */
export interface AssessOptions {
  /**
   * The caller that published the hold for THIS turn. Its own capture is not a
   * busy microphone: the hold goes up before the question by design, so the
   * preflight has to tell "my caller is holding" from "another tool is
   * recording".
   */
  ownerPid?: number;
  /** Where the caller published the hold, checked against the file core reads. */
  expectedCapturePath?: string;
}

export function assessCore(read: CoreHealthRead, options: AssessOptions = {}): CoreAssessment {
  if (read.status === "rate_limited") {
    return {
      ok: false,
      code: "core_rate_limited",
      detail:
        "core is rate-limiting this client (ten requests a minute, shared with /notify). " +
        "One ask costs several of them, so wait a moment before asking again.",
    };
  }
  if (read.status === "unreachable") {
    return { ok: false, code: "core_unreachable", detail: "core did not answer GET /health" };
  }
  const health = read.health;
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
  if (
    options.expectedCapturePath !== undefined &&
    options.expectedCapturePath !== capturePath
  ) {
    return {
      ok: false,
      code: "capture_path_mismatch",
      detail:
        `core reads its capture state from ${capturePath}, but this caller published its hold to ` +
        `${options.expectedCapturePath}. Core would never see the hold, so the recording would have ` +
        "no interlock. Point ECHO_CAPTURE_STATE_PATH at the same file for both.",
    };
  }

  if (health.capture_guard.state !== "idle") {
    // The caller's own hold is expected here and is not a conflict. A core that
    // does not report the holder cannot distinguish them, so it stays strict.
    const holder = health.capture_guard.pid;
    const heldByThisCaller =
      options.ownerPid !== undefined && holder !== undefined && holder !== null && holder === options.ownerPid;
    if (!heldByThisCaller) {
      return {
        ok: false,
        code: "microphone_busy",
        detail: `another capture is ${health.capture_guard.state}`,
      };
    }
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
  /** The caller's capture-state secret, so core speaks into the caller's own hold. */
  captureNonce?: string;
}

/**
 * Speak the question and wait for core's verdict on THIS question.
 *
 * `await_playback` is what makes the interlock real: the response arrives when
 * the line has reached a terminal disposition, so the answer is about this
 * session rather than about the global queue. `capture_bypass_nonce` is what
 * makes it speakable at all, because the caller's hold is already up by now and
 * would otherwise silence the question it is holding for.
 *
 * `voice_enabled` is forced on: a silent question would leave the human recorded
 * against a prompt they never heard.
 */
export async function speakQuestion(
  options: SpeakQuestionOptions,
): Promise<{ status: number; disposition: string }> {
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
      await_playback: true,
      capture_bypass_nonce: options.captureNonce,
    }),
  });

  if (response.status < 200 || response.status >= 300) {
    return { status: response.status, disposition: `http_${response.status}` };
  }

  // A core too old for await_playback answers 202 on receipt with no
  // disposition. Reporting that as unknown is the honest reading: this build
  // cannot prove the question played, so the turn will be refused.
  try {
    const body = (await response.json()) as { disposition?: unknown };
    return {
      status: response.status,
      disposition: typeof body.disposition === "string" ? body.disposition : "unknown",
    };
  } catch {
    return { status: response.status, disposition: "unparseable" };
  }
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
  /**
   * Polls core refused or failed to answer. Non-zero with `drained: false` means
   * the wait ran out of readings, not that the queue was busy - the difference
   * between "your play queue is backed up" and "you asked twice in a minute".
   */
  refused_reads: number;
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
  const backoff = options.pollIntervalMs === undefined
    ? DRAIN_BACKOFF_MS
    : Array(Math.max((options.maxPolls ?? DRAIN_BACKOFF_MS.length + 1) - 1, 0)).fill(options.pollIntervalMs);
  const maxPolls = options.maxPolls ?? backoff.length + 1;

  await sleep(options.estimateMs);
  let waited = options.estimateMs;
  let refused = 0;

  for (let poll = 1; poll <= maxPolls; poll++) {
    const read = await readCoreHealth(options.coreBaseUrl, options.fetchImpl);
    // A rate-limited or failed read is not evidence the queue is empty. Keep
    // waiting: opening the microphone on a guess is the expensive mistake.
    if (read.status !== "ok") refused++;
    else if (queueIsIdle(read.health)) {
      return { drained: true, waited_ms: waited, polls: poll, refused_reads: refused };
    }
    if (poll === maxPolls) {
      return { drained: false, waited_ms: waited, polls: poll, refused_reads: refused };
    }
    const gap = backoff[Math.min(poll - 1, backoff.length - 1)] ?? 0;
    await sleep(gap);
    waited += gap;
  }
  return { drained: false, waited_ms: waited, polls: maxPolls, refused_reads: refused };
}

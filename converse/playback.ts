// Speaking the question through core, and knowing when it has finished.
//
// Converse writes no TTS code: the question goes out as an ordinary POST
// /notify, so it rides the whole existing provider chain, cache, pronunciation
// pass and play queue. What converse has to add is the part /notify cannot give
// it - notify acks 202 on receipt, so the caller never learns when the line
// actually played, and the microphone must not open until it has.
//
// So the question opts into core's per-request completion state and the wait
// polls THAT request's own outcome: `completed` (with the capture reservation
// core activated in the same turn), `failed`, or no verdict inside the budget.
// A question dropped by the queue's age cap therefore reads as `failed` rather
// than being indistinguishable from one that played.
//
// Two constraints shape the waiting strategy, and the second one is easy to miss:
//
//  * Completion reads have their own rate-limit bucket, but it is the same size
//    as every other (10 requests per minute per client) and one turn also spends
//    a /health and a /notify. So converse estimates the speech duration from the
//    question's length, sleeps that out, and only then polls sparsely.
//  * The question is posted under a session id unique to the turn. The play
//    queue coalesces newest-per-session, so sharing the host's session id would
//    let a later host line replace the question - core would then stay silent
//    while the caller happily recorded.

import type { CoreHealthSnapshot } from "./types.ts";

/** edge-tts speaks near 14 characters a second; the constant covers synthesis and playback start. */
const SPEECH_OVERHEAD_MS = 1_200;
const MS_PER_CHARACTER = 70;

// Backoff rather than a fixed cadence, and this is a budget decision as much as
// a latency one. Every core bucket allows ten requests a minute per client, so
// one ask can afford about four completion reads before a second ask inside the
// same minute starts getting 429s. Early polls stay close together (the human
// should not sit in silence after the question), then widen fast so a slow
// synthesis costs one more request, not six.
const COMPLETION_BACKOFF_MS = [750, 1_250, 2_000, 3_500] as const;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type SleepLike = (ms: number) => Promise<void>;

export const realSleep: SleepLike = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      code: "core_unreachable" | "core_rate_limited" | "core_muted" | "capture_guard_disabled";
      detail: string;
    }
  | { ok: false; code: "microphone_busy"; detail: string };

/**
 * Decide whether a turn can start at all. Each refusal below is a case where the
 * turn would otherwise record into a silence the human never heard, or record
 * with no interlock protecting the recording.
 */
export function assessCore(read: CoreHealthRead): CoreAssessment {
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
  if (health.capture_guard.state !== "idle") {
    return {
      ok: false,
      code: "microphone_busy",
      detail: `another capture is ${health.capture_guard.state}`,
    };
  }
  if (health.capture_reservation?.held) {
    return {
      ok: false,
      code: "microphone_busy",
      detail: "another turn is holding the core playback reservation",
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
  ownerPid: number;
  leaseMs: number;
  fetchImpl: FetchLike;
}

/**
 * Post the question. `voice_enabled` is forced on: a silent question would leave
 * the human recorded against a prompt they never heard.
 */
export async function speakQuestion(options: SpeakQuestionOptions): Promise<{ status: number; body: string; requestId?: string }> {
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
      capture_reservation: { owner_pid: options.ownerPid, lease_ms: options.leaseMs },
    }),
  });
  const body = await response.text();
  let requestId: string | undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (typeof parsed.request_id === "string") requestId = parsed.request_id;
  } catch {
    // The coordinator reports the HTTP status; a non-JSON body remains a stable
    // question-not-spoken failure at that boundary.
  }
  return { status: response.status, body, requestId };
}

export type PlaybackCompletionRead =
  | { status: "ok"; state: "queued" | "playing" | "completed" | "failed"; capture_reservation_id?: string; detail?: string }
  | { status: "rate_limited" | "unreachable" };

async function readPlaybackCompletion(
  coreBaseUrl: string,
  requestId: string,
  fetchImpl: FetchLike,
): Promise<PlaybackCompletionRead> {
  try {
    const response = await fetchImpl(`${coreBaseUrl}/notify/${encodeURIComponent(requestId)}/completion`);
    if (response.status === 429) return { status: "rate_limited" };
    if (!response.ok) return { status: "unreachable" };
    const body = (await response.json()) as Record<string, unknown>;
    const state = body.state;
    if (state === "queued" || state === "playing" || state === "completed" || state === "failed") {
      return {
        status: "ok",
        state,
        ...(typeof body.capture_reservation_id === "string" ? { capture_reservation_id: body.capture_reservation_id } : {}),
        ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
      };
    }
    return { status: "unreachable" };
  } catch {
    return { status: "unreachable" };
  }
}

export interface PlaybackCompletionOptions {
  coreBaseUrl: string;
  requestId: string;
  estimateMs: number;
  fetchImpl: FetchLike;
  sleep?: SleepLike;
  pollIntervalMs?: number;
  maxPolls?: number;
}

export interface PlaybackCompletionReport {
  completed: boolean;
  state: "completed" | "failed" | "unknown";
  capture_reservation_id?: string;
  detail?: string;
  waited_ms: number;
  polls: number;
  refused_reads: number;
}

/** Wait for the exact /notify request, not a shared queue snapshot. */
export async function waitForPlaybackCompletion(options: PlaybackCompletionOptions): Promise<PlaybackCompletionReport> {
  const sleep = options.sleep ?? realSleep;
  const backoff = options.pollIntervalMs === undefined
    ? COMPLETION_BACKOFF_MS
    : Array(Math.max((options.maxPolls ?? COMPLETION_BACKOFF_MS.length + 1) - 1, 0)).fill(options.pollIntervalMs);
  const maxPolls = options.maxPolls ?? backoff.length + 1;

  await sleep(options.estimateMs);
  let waited = options.estimateMs;
  let refused = 0;

  for (let poll = 1; poll <= maxPolls; poll++) {
    const read = await readPlaybackCompletion(options.coreBaseUrl, options.requestId, options.fetchImpl);
    if (read.status !== "ok") {
      refused++;
    } else if (read.state === "completed") {
      return {
        completed: true,
        state: "completed",
        capture_reservation_id: read.capture_reservation_id,
        waited_ms: waited,
        polls: poll,
        refused_reads: refused,
      };
    } else if (read.state === "failed") {
      return {
        completed: false,
        state: "failed",
        detail: read.detail,
        waited_ms: waited,
        polls: poll,
        refused_reads: refused,
      };
    }
    if (poll === maxPolls) break;
    const gap = backoff[Math.min(poll - 1, backoff.length - 1)] ?? 0;
    await sleep(gap);
    waited += gap;
  }

  return { completed: false, state: "unknown", waited_ms: waited, polls: maxPolls, refused_reads: refused };
}


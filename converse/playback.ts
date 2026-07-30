// Speaking the question through core, and knowing when it has finished.
//
// Converse writes no TTS code: the question goes out as an ordinary POST
// /notify, so it rides the whole existing provider chain, cache, pronunciation
// pass and play queue. What converse has to add is the part /notify cannot give
// it - notify acks 202 on receipt, so the caller never learns when the line
// actually played, and the microphone must not open until it has.
//
// That is what `await_playback` gives it: core holds the response until the line
// reaches a terminal disposition and answers 200 with it, so the answer is about
// THIS question rather than about the global queue. An earlier version inferred
// completion by polling shared GET /health for an idle play queue; queue depth
// is global, so an idle reading could not tell "my line is done" from "my line
// has not started", and that polling is gone rather than kept as a fallback.
//
// One constraint still shapes what this module may spend: GET /health shares
// /notify's rate-limit bucket (ten requests per minute per client), and starving
// the host's own notifications is the failure that bucket exists to prevent. The
// preflight read below is the only /health call a turn makes.
//
// The question is posted under a session id unique to the turn. The play queue
// coalesces newest-per-session, so sharing the host's session id would let a
// later host line replace the question - core would then stay silent while the
// caller happily recorded.

import type { CoreHealthSnapshot } from "./types.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

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
        | "capture_path_mismatch"
        | "core_version_skew";
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
    // The caller's own hold is expected here and is not a conflict, because it
    // goes up before the question is spoken by design. Telling it from a foreign
    // recorder needs the holder pid, so a core that does not report one is a
    // version skew rather than a busy microphone: blaming a phantom recorder
    // would send the operator hunting a tool that is not running.
    const holder = health.capture_guard.pid;
    if (holder === undefined || holder === null) {
      return {
        ok: false,
        code: "core_version_skew",
        detail:
          `core reports a capture hold (${health.capture_guard.state}) but not which process owns it, ` +
          "so this caller's own hold cannot be told from another tool's recording. That field arrived " +
          "with this interlock: run `cli/echo update` to re-stage the daemon payload.",
      };
    }
    if (options.ownerPid === undefined || holder !== options.ownerPid) {
      return {
        ok: false,
        code: "microphone_busy",
        detail: `another capture is ${health.capture_guard.state} (pid ${holder})`,
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


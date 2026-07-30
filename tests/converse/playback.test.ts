import { describe, expect, test } from "bun:test";
import {
  assessCore,
  estimateSpeechMs,
  speakQuestion,
  turnSessionId,
  waitForPlaybackCompletion,
  type FetchLike,
} from "../../converse/playback.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

function health(overrides: Partial<CoreHealthSnapshot> = {}): CoreHealthSnapshot {
  return {
    mute: { muted: false, muted_until: null },
    capture_guard: { path: "/state/recording-state.json", state: "idle" },
    play_queue: { depth: 0, in_flight_ms: null, stalled: false },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("speaking the question through core", () => {
  test("posts /notify with voice forced on and a turn-unique session id", async () => {
    let body: any;
    const fetchImpl: FetchLike = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return jsonResponse({ status: "accepted", request_id: "request-1" }, 202);
    };

    const result = await speakQuestion({
      coreBaseUrl: "http://localhost:8899",
      question: "Which branch should I ship?",
      turnId: "turn-abc",
      voiceId: "pi",
      source: "pi",
      ownerPid: 1234,
      leaseMs: 120_000,
      fetchImpl,
    });

    expect(result.status).toBe(202);
    expect(body.message).toBe("Which branch should I ship?");
    expect(body.voice_enabled).toBe(true);
    expect(body.voice_id).toBe("pi");
    expect(body.source).toBe("pi");
    expect(body.capture_reservation).toEqual({ owner_pid: 1234, lease_ms: 120_000 });
    // Newest-per-session coalescing must never be able to replace the question
    // with a later host line, so the session id belongs to the turn alone.
    expect(body.session_id).toBe("converse:turn-abc");
    expect(turnSessionId("turn-abc")).not.toBe("turn-abc");
  });

  test("a longer question is given longer to play", () => {
    expect(estimateSpeechMs("Hi?")).toBeLessThan(estimateSpeechMs("Hi, could you tell me which branch to ship?"));
    expect(estimateSpeechMs("")).toBeGreaterThan(0);
  });
});

describe("waiting for the question to finish playing", () => {
  /** A core stand-in that answers this request's own completion route, in sequence. */
  function completionCore(states: Array<"queued" | "playing" | "completed" | "failed" | null>) {
    const calls: string[] = [];
    let index = 0;
    const fetchImpl: FetchLike = async (url, init) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      const state = states[Math.min(index++, states.length - 1)];
      if (state === null) return new Response("rate limited", { status: 429 });
      return jsonResponse({
        request_id: "r-1",
        state,
        ...(state === "completed" ? { capture_reservation_id: "r-1" } : {}),
        ...(state === "failed" ? { detail: "dropped by the age cap" } : {}),
      });
    };
    return { calls, fetchImpl };
  }

  const wait = (core: { fetchImpl: FetchLike }, overrides = {}) =>
    waitForPlaybackCompletion({
      coreBaseUrl: "http://localhost:8899",
      requestId: "r-1",
      estimateMs: 0,
      fetchImpl: core.fetchImpl,
      sleep: async () => {},
      ...overrides,
    });

  test("sleeps out the estimated speech before spending a single poll", async () => {
    const slept: number[] = [];
    const core = completionCore(["completed"]);

    const report = await waitForPlaybackCompletion({
      coreBaseUrl: "http://localhost:8899",
      requestId: "r-1",
      estimateMs: 4_000,
      fetchImpl: core.fetchImpl,
      sleep: async (ms) => void slept.push(ms),
    });

    // The estimate carries the wait; every core bucket allows ten requests a
    // minute, so a tight poll loop would 429 the next ask.
    expect(slept[0]).toBe(4_000);
    expect(report.completed).toBe(true);
    expect(report.capture_reservation_id).toBe("r-1");
    expect(report.polls).toBe(1);
    expect(core.calls).toEqual(["GET /notify/r-1/completion"]);
  });

  test("keeps waiting while the question is still queued or playing", async () => {
    const core = completionCore(["queued", "playing", "completed"]);

    const report = await wait(core, { pollIntervalMs: 1_000 });

    expect(report.completed).toBe(true);
    expect(report.polls).toBe(3);
    expect(report.waited_ms).toBe(2_000);
  });

  // The whole point of the per-request record: a question the queue dropped is
  // reported as failed instead of being indistinguishable from one that played.
  test("a dropped question reads as failed, with core's own reason", async () => {
    const report = await wait(completionCore(["failed"]));

    expect(report.completed).toBe(false);
    expect(report.state).toBe("failed");
    expect(report.detail).toBe("dropped by the age cap");
    expect(report.capture_reservation_id).toBeUndefined();
  });

  test("a rate-limited poll is not read as a finished question", async () => {
    // 429 twice, then completed: a refused read must never be mistaken for
    // "the question is done", or the microphone opens over the question.
    const report = await wait(completionCore([null, null, "completed"]));

    expect(report.completed).toBe(true);
    expect(report.polls).toBe(3);
    expect(report.refused_reads).toBe(2);
  });

  test("gives up after a bounded number of polls instead of waiting forever", async () => {
    const report = await wait(completionCore(["playing"]), { maxPolls: 3 });

    // 0 + 750 + 1250: the gaps come from the backoff schedule.
    expect(report.completed).toBe(false);
    expect(report.state).toBe("unknown");
    expect(report.waited_ms).toBe(2_000);
    expect(report.polls).toBe(3);
    expect(report.refused_reads).toBe(0);
  });

  test("a wait that ran out of readings is distinguishable from a slow queue", async () => {
    // Same symptom, opposite fixes: "your play queue is backed up" versus "you
    // asked twice inside a minute". The count is what lets the caller say which.
    const refused = await wait(completionCore([null]), { maxPolls: 3 });
    const busy = await wait(completionCore(["playing"]), { maxPolls: 3 });

    expect(refused.refused_reads).toBe(3);
    expect(busy.refused_reads).toBe(0);
  });

  test("polls back off so a slow synthesis costs one more request, not six", async () => {
    const slept: number[] = [];
    const core = completionCore(["playing"]);

    const report = await waitForPlaybackCompletion({
      coreBaseUrl: "http://localhost:8899",
      requestId: "r-1",
      estimateMs: 2_000,
      fetchImpl: core.fetchImpl,
      sleep: async (ms) => void slept.push(ms),
    });

    // An ask can afford about four completion reads before a second ask inside
    // the same minute starts getting 429s, so the gaps widen instead of repeating.
    expect(report.completed).toBe(false);
    expect(report.polls).toBeLessThanOrEqual(5);
    expect(slept).toEqual([2_000, 750, 1_250, 2_000, 3_500]);
    expect(slept.slice(1)).toEqual([...slept.slice(1)].sort((a, b) => a - b));
  });
});

/** assessCore reads the result of a health fetch, not the snapshot directly. */
const reads = (snapshot: CoreHealthSnapshot) => ({ status: "ok" as const, health: snapshot });

describe("core preflight", () => {
  test("accepts an idle, unmuted core and reports the path core itself reads", () => {
    expect(assessCore(reads(health()))).toEqual({ ok: true, capture_state_path: "/state/recording-state.json" });
  });

  test("refuses when core is unreachable", () => {
    const verdict = assessCore({ status: "unreachable" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("core_unreachable");
  });

  // Rate limiting and a dead daemon look identical over the wire but mean
  // opposite things: "wait a moment" versus "your voice daemon is down".
  test("reports core's rate limit as its own reason, not as an unreachable core", () => {
    const verdict = assessCore({ status: "rate_limited" });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("core_rate_limited");
      expect(verdict.detail).toContain("ten requests a minute");
    }
  });

  test("refuses while core is muted, rather than recording against a silent question", () => {
    const verdict = assessCore(reads(health({ mute: { muted: true, muted_until: null } })));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("core_muted");
  });

  test("refuses when the capture guard is disabled, since nothing would hold core's speech", () => {
    for (const path of [null, ""]) {
      const verdict = assessCore(reads(health({ capture_guard: { path, state: "idle" } })));
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.code).toBe("capture_guard_disabled");
    }
  });

  test("reports another live capture as a busy microphone", () => {
    const verdict = assessCore(reads(health({
      capture_guard: { path: "/state/recording-state.json", state: "recording" },
    })));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("microphone_busy");
  });
});

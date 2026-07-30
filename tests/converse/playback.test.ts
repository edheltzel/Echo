import { describe, expect, test } from "bun:test";
import {
  assessCore,
  estimateSpeechMs,
  speakQuestion,
  turnSessionId,
  waitForPlaybackDrain,
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

/** A core stand-in that records the calls made against it, in order. */
function fakeCore(healthSequence: (CoreHealthSnapshot | null)[]) {
  const calls: string[] = [];
  let healthIndex = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/notify") return jsonResponse({ status: "accepted", request_id: "r-1" }, 202);
    const next = healthSequence[Math.min(healthIndex++, healthSequence.length - 1)];
    return next === null ? new Response("rate limited", { status: 429 }) : jsonResponse(next);
  };
  return { calls, fetchImpl };
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
  test("sleeps out the estimated speech before spending a single poll", async () => {
    const slept: number[] = [];
    const core = fakeCore([health()]);

    const report = await waitForPlaybackDrain({
      coreBaseUrl: "http://localhost:8899",
      estimateMs: 4_000,
      fetchImpl: core.fetchImpl,
      sleep: async (ms) => void slept.push(ms),
    });

    // The estimate carries the wait; /health shares /notify's 10-per-minute
    // bucket, so a tight poll loop would starve the host's notifications.
    expect(slept[0]).toBe(4_000);
    expect(report).toEqual({ drained: true, waited_ms: 4_000, polls: 1, refused_reads: 0 });
    expect(core.calls).toEqual(["GET /health"]);
  });

  test("keeps waiting while the queue is still busy", async () => {
    const core = fakeCore([
      health({ play_queue: { depth: 1, in_flight_ms: null, stalled: false } }),
      health({ play_queue: { depth: 0, in_flight_ms: 800, stalled: false } }),
      health(),
    ]);

    const report = await waitForPlaybackDrain({
      coreBaseUrl: "http://localhost:8899",
      estimateMs: 100,
      fetchImpl: core.fetchImpl,
      sleep: async () => {},
      pollIntervalMs: 1_000,
    });

    expect(report.drained).toBe(true);
    expect(report.polls).toBe(3);
    expect(report.waited_ms).toBe(2_100);
  });

  test("a rate-limited poll is not read as an empty queue", async () => {
    // 429 twice, then an idle queue: a refused read must never be mistaken for
    // "nothing is playing", or the microphone opens over the question.
    const core = fakeCore([null, null, health()]);

    const report = await waitForPlaybackDrain({
      coreBaseUrl: "http://localhost:8899",
      estimateMs: 0,
      fetchImpl: core.fetchImpl,
      sleep: async () => {},
    });

    expect(report.drained).toBe(true);
    expect(report.polls).toBe(3);
  });

  test("gives up after a bounded number of polls instead of waiting forever", async () => {
    const core = fakeCore([health({ play_queue: { depth: 3, in_flight_ms: 500, stalled: false } })]);

    const report = await waitForPlaybackDrain({
      coreBaseUrl: "http://localhost:8899",
      estimateMs: 0,
      fetchImpl: core.fetchImpl,
      sleep: async () => {},
      maxPolls: 3,
    });

    // 0 + 750 + 1250: the gaps come from the backoff schedule.
    expect(report).toEqual({ drained: false, waited_ms: 2_000, polls: 3, refused_reads: 0 });
  });

  test("a wait that ran out of readings is distinguishable from a busy queue", async () => {
    // Same symptom, opposite fixes: "your play queue is backed up" versus "you
    // asked twice inside a minute". The count is what lets the caller say which.
    const refused = fakeCore([null]);
    const busy = fakeCore([health({ play_queue: { depth: 4, in_flight_ms: 200, stalled: false } })]);
    const wait = (core: ReturnType<typeof fakeCore>) =>
      waitForPlaybackDrain({
        coreBaseUrl: "http://localhost:8899",
        estimateMs: 0,
        fetchImpl: core.fetchImpl,
        sleep: async () => {},
        maxPolls: 3,
      });

    const refusedReport = await wait(refused);
    const busyReport = await wait(busy);

    expect(refusedReport.drained).toBe(false);
    expect(refusedReport.refused_reads).toBe(3);
    expect(busyReport.drained).toBe(false);
    expect(busyReport.refused_reads).toBe(0);
  });

  test("polls back off so a slow synthesis costs one more request, not six", async () => {
    const slept: number[] = [];
    const core = fakeCore([health({ play_queue: { depth: 1, in_flight_ms: 900, stalled: false } })]);

    const report = await waitForPlaybackDrain({
      coreBaseUrl: "http://localhost:8899",
      estimateMs: 2_000,
      fetchImpl: core.fetchImpl,
      sleep: async (ms) => void slept.push(ms),
    });

    // An ask can afford three or four core requests before it starts eating the
    // host's own notification budget, so the gaps widen instead of repeating.
    expect(report.drained).toBe(false);
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

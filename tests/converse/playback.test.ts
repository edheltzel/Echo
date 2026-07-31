import { describe, expect, test } from "bun:test";
import {
  assessCore,
  estimateSpeechMs,
  releaseCaptureReservation,
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

type CompletionReply = { state: string; capture_reservation_id?: string; detail?: string } | null;

/**
 * A core stand-in serving the per-request completion route, recording the calls
 * made against it in order. `null` stands for a 429.
 */
function fakeCore(completions: CompletionReply[]) {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/notify") return jsonResponse({ status: "accepted", request_id: "r-1" }, 202);
    const next = completions[Math.min(index++, completions.length - 1)];
    return next === null ? new Response("rate limited", { status: 429 }) : jsonResponse(next);
  };
  return { calls, fetchImpl };
}

const completed = (reservationId = "turn-abc") => ({ state: "completed", capture_reservation_id: reservationId });
const playing = () => ({ state: "playing" });

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
      reservationId: "turn-abc",
      fetchImpl,
    });

    expect(result.status).toBe(202);
    expect(body.message).toBe("Which branch should I ship?");
    expect(body.voice_enabled).toBe(true);
    expect(body.voice_id).toBe("pi");
    expect(body.source).toBe("pi");
    expect(body.capture_reservation).toEqual({
      owner_pid: 1234,
      lease_ms: 120_000,
      reservation_id: "turn-abc",
    });
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
  const wait = (core: ReturnType<typeof fakeCore>, overrides: Record<string, unknown> = {}) =>
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
    const core = fakeCore([completed()]);

    const report = await wait(core, { estimateMs: 4_000, sleep: async (ms: number) => void slept.push(ms) });

    // The estimate carries the wait: completion polls have their own bucket, but
    // it is still ten a minute and one turn can spend five of them.
    expect(slept[0]).toBe(4_000);
    expect(report).toEqual({
      completed: true,
      state: "completed",
      capture_reservation_id: "turn-abc",
      waited_ms: 4_000,
      polls: 1,
      refused_reads: 0,
    });
    expect(core.calls).toEqual(["GET /notify/r-1/completion"]);
  });

  test("keeps waiting while this request is still playing", async () => {
    const core = fakeCore([{ state: "queued" }, playing(), completed()]);

    const report = await wait(core, { estimateMs: 100, pollIntervalMs: 1_000 });

    expect(report.completed).toBe(true);
    expect(report.polls).toBe(3);
    expect(report.waited_ms).toBe(2_100);
  });

  test("a rate-limited poll is not read as a finished question", async () => {
    // 429 twice, then completed: a refused read must never be mistaken for
    // "the question is done", or the microphone opens over it.
    const core = fakeCore([null, null, completed()]);

    const report = await wait(core);

    expect(report.completed).toBe(true);
    expect(report.polls).toBe(3);
  });

  test("reports a failed playback with core's own reason instead of waiting it out", async () => {
    // The signal the queue-depth reading could never give: this exact request
    // was superseded or dropped, so the caller must not record.
    const core = fakeCore([{ state: "failed", detail: "superseded: newer line for session" }]);

    const report = await wait(core);

    expect(report).toEqual({
      completed: false,
      state: "failed",
      detail: "superseded: newer line for session",
      waited_ms: 0,
      polls: 1,
      refused_reads: 0,
    });
  });

  test("gives up after a bounded number of polls instead of waiting forever", async () => {
    const core = fakeCore([playing()]);

    const report = await wait(core, { maxPolls: 3 });

    // 0 + 750 + 1250: the gaps come from the backoff schedule.
    expect(report).toEqual({ completed: false, state: "unknown", waited_ms: 2_000, polls: 3, refused_reads: 0 });
  });

  test("a wait that ran out of readings is distinguishable from a slow queue", async () => {
    // Same symptom, opposite fixes: "your play queue is backed up" versus "you
    // asked twice inside a minute". The count is what lets the caller say which.
    const refusedReport = await wait(fakeCore([null]), { maxPolls: 3 });
    const busyReport = await wait(fakeCore([playing()]), { maxPolls: 3 });

    expect(refusedReport.completed).toBe(false);
    expect(refusedReport.refused_reads).toBe(3);
    expect(busyReport.completed).toBe(false);
    expect(busyReport.refused_reads).toBe(0);
  });

  test("polls back off so a slow synthesis costs one more request, not six", async () => {
    const slept: number[] = [];
    const core = fakeCore([playing()]);

    const report = await wait(core, { estimateMs: 2_000, sleep: async (ms: number) => void slept.push(ms) });

    expect(report.completed).toBe(false);
    expect(report.polls).toBeLessThanOrEqual(5);
    expect(slept).toEqual([2_000, 750, 1_250, 2_000, 3_500]);
    expect(slept.slice(1)).toEqual([...slept.slice(1)].sort((a, b) => a - b));
  });
});

describe("releasing core's capture reservation", () => {
  const release = (fetchImpl: FetchLike) =>
    releaseCaptureReservation("http://localhost:8899", "turn-abc", fetchImpl);

  test("reports success on the first landed release", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(new URL(url).pathname);
      return jsonResponse({ reservation_id: "turn-abc", acknowledged: true, matched: true });
    };

    expect(await release(fetchImpl)).toEqual({ released: true, attempts: 1 });
    expect(calls).toEqual(["/notify/capture-reservations/turn-abc/release"]);
  });

  test("retries once, because a rate-limited release strands the interlock", async () => {
    let attempts = 0;
    const fetchImpl: FetchLike = async () => {
      attempts++;
      return attempts === 1 ? new Response("rate limited", { status: 429 }) : jsonResponse({ acknowledged: true });
    };

    expect(await release(fetchImpl)).toEqual({ released: true, attempts: 2 });
  });

  test("treats a 404 as released: a core that does not know the id is not holding it", async () => {
    const fetchImpl: FetchLike = async () => new Response("no such route", { status: 404 });

    expect(await release(fetchImpl)).toEqual({ released: true, attempts: 1 });
  });

  test("reports the failure instead of claiming a release that never landed", async () => {
    // The caller logs this. Silently discarding it leaves core holding the
    // reservation and every later voice line held for capture, with nothing
    // recording and nobody told.
    const fetchImpl: FetchLike = async () => { throw new Error("connection refused"); };

    expect(await release(fetchImpl)).toEqual({ released: false, attempts: 2, detail: "connection refused" });
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
    if (verdict.ok === false) expect(verdict.code).toBe("core_unreachable");
  });

  // Rate limiting and a dead daemon look identical over the wire but mean
  // opposite things: "wait a moment" versus "your voice daemon is down".
  test("reports core's rate limit as its own reason, not as an unreachable core", () => {
    const verdict = assessCore({ status: "rate_limited" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.code).toBe("core_rate_limited");
      expect(verdict.detail).toContain("ten requests a minute");
    }
  });

  test("refuses while core is muted, rather than recording against a silent question", () => {
    const verdict = assessCore(reads(health({ mute: { muted: true, muted_until: null } })));
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe("core_muted");
  });

  test("refuses when the capture guard is disabled, since nothing would hold core's speech", () => {
    for (const path of [null, ""]) {
      const verdict = assessCore(reads(health({ capture_guard: { path, state: "idle" } })));
      expect(verdict.ok).toBe(false);
      if (verdict.ok === false) expect(verdict.code).toBe("capture_guard_disabled");
    }
  });

  test("reports another live capture as a busy microphone", () => {
    const verdict = assessCore(reads(health({
      capture_guard: { path: "/state/recording-state.json", state: "recording" },
    })));
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) expect(verdict.code).toBe("microphone_busy");
  });
});

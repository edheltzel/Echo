import { describe, expect, test } from "bun:test";
import {
  assessCore,
  speakQuestion,
  turnSessionId,
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
      return jsonResponse({ status: "accepted" }, 202);
    };

    const result = await speakQuestion({
      coreBaseUrl: "http://localhost:8899",
      question: "Which branch should I ship?",
      turnId: "turn-abc",
      voiceId: "pi",
      source: "pi",
      fetchImpl,
    });

    expect(result.status).toBe(202);
    expect(body.message).toBe("Which branch should I ship?");
    expect(body.voice_enabled).toBe(true);
    expect(body.voice_id).toBe("pi");
    expect(body.source).toBe("pi");
    // Newest-per-session coalescing must never be able to replace the question
    // with a later host line, so the session id belongs to the turn alone.
    expect(body.session_id).toBe("converse:turn-abc");
    expect(turnSessionId("turn-abc")).not.toBe("turn-abc");
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

  test("reports another live capture as a busy microphone, naming the holder", () => {
    const verdict = assessCore(
      reads(health({ capture_guard: { path: "/state/recording-state.json", state: "recording", pid: 9_001 } })),
      { ownerPid: 4_242 },
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe("microphone_busy");
      expect(verdict.detail).toContain("9001");
    }
  });

  test("this caller's own hold is not a busy microphone", () => {
    // The hold goes up before the question by design, so the preflight always
    // sees it. Reading it as a conflict would refuse every ask.
    const verdict = assessCore(
      reads(health({ capture_guard: { path: "/state/recording-state.json", state: "recording", pid: 4_242 } })),
      { ownerPid: 4_242 },
    );
    expect(verdict).toEqual({ ok: true, capture_state_path: "/state/recording-state.json" });
  });

  // A daemon predating the interlock reports no holder pid, and every ask would
  // then blame a phantom foreign recorder. The real cause is a stale payload, so
  // it is reported by name with the command that re-stages it.
  test("a core that reports no holder is named as version skew, not a foreign recorder", () => {
    for (const pid of [undefined, null]) {
      const verdict = assessCore(
        reads(health({ capture_guard: { path: "/state/recording-state.json", state: "recording", pid } })),
        { ownerPid: 4_242 },
      );
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) {
        expect(verdict.code).toBe("core_version_skew");
        expect(verdict.detail).toContain("cli/echo update");
      }
    }
  });
});

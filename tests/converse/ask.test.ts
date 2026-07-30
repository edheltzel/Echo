import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskError, askOnce, ensureCoordinator, resolveAncestry } from "../../converse/client.ts";
import { CaptureError, type CaptureEngine } from "../../converse/capture.ts";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";
import { createConverseServer, type ConverseServerHandle } from "../../converse/server.ts";
import { readCaptureState } from "../../core/capture-guard.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

// The full one-shot turn, driven against a real coordinator on an ephemeral
// port and a fake core. No microphone, no real daemon, no real state path.

let scratch: string;
let capturePath: string;
let handles: ConverseServerHandle[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-ask-"));
  capturePath = join(scratch, "recording-state.json");
});

afterEach(() => {
  for (const handle of handles) handle.stop();
  handles = [];
  rmSync(scratch, { recursive: true, force: true });
});

function coreHealth(overrides: Partial<CoreHealthSnapshot> = {}): CoreHealthSnapshot {
  return {
    mute: { muted: false, muted_until: null },
    capture_guard: { path: capturePath, state: "idle" },
    play_queue: { depth: 0, in_flight_ms: null, stalled: false },
    ...overrides,
  };
}

/** Reads the capture state at the moment core is asked to speak. */
function fakeCore(health: CoreHealthSnapshot = coreHealth()) {
  const observed: { notifyCaptureState: string | null; calls: string[] } = {
    notifyCaptureState: null,
    calls: [],
  };
  return {
    observed,
    fetchImpl: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      observed.calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/notify") {
        observed.notifyCaptureState = existsSync(capturePath)
          ? String(JSON.parse(readFileSync(capturePath, "utf8")).state)
          : "absent";
        return new Response(JSON.stringify({ status: "accepted", request_id: "request-1" }), { status: 202 });
      }
      if (path === "/notify/request-1/completion") {
        return new Response(JSON.stringify({ request_id: "request-1", state: "completed", capture_reservation_id: "request-1" }), { status: 200 });
      }
      return new Response(JSON.stringify(health), { status: 200 });
    },
  };
}

function startCoordinator(core = fakeCore()) {
  const config: ConverseConfig = {
    ...resolveConverseConfig({}, scratch),
    bookingLockPath: join(scratch, "booking.lock"),
    coreBaseUrl: "http://core.test",
  };
  const handle = createConverseServer({
    config,
    port: 0,
    fetchImpl: core.fetchImpl,
    sleep: async () => {},
  });
  handles.push(handle);
  return { core, config: { ...config, baseUrl: `http://127.0.0.1:${handle.port}` }, handle };
}

/** A capture engine that records what the capture state was while it "recorded". */
function recordingEngine(text = "ship it into dev"): { engine: CaptureEngine; sawState: string[] } {
  const sawState: string[] = [];
  const engine: CaptureEngine = async () => {
    sawState.push(readCaptureState(capturePath, () => true));
    return { text, engine: "yap", capture_ms: 1_234, timed_out: false };
  };
  return { engine, sawState };
}

describe("one-shot ask", () => {
  test("speaks the question, captures the reply, and returns the transcript", async () => {
    const { core, config } = startCoordinator();
    const { engine, sawState } = recordingEngine("merge it tomorrow");

    const result = await askOnce(
      { question: "When should I merge?", source: "test", voiceId: "pi" },
      { config, captureEngine: engine, fetchImpl: (url, init) => fetch(url, init), ancestry: ["1 launchd"] },
    );

    expect(result.text).toBe("merge it tomorrow");
    expect(result.engine).toBe("yap");
    expect(result.capture_ms).toBe(1_234);
    expect(result.turn_id).toMatch(/^t-/);
    expect(result.spoke.drained).toBe(true);
    expect(result.ancestry).toEqual(["1 launchd"]);
    expect(core.observed.calls).toContain("POST /notify");
    expect(sawState).toEqual(["recording"]);
  });

  test("core is never asked to speak while a capture is published", async () => {
    // The self-hold trap: had the capture state been `recording` at this point,
    // core's own guard would have held back the question converse just asked it
    // to speak, and the human would have been recorded against silence.
    const { core, config } = startCoordinator();
    const { engine } = recordingEngine();

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: (u, i) => fetch(u, i) });

    expect(core.observed.notifyCaptureState).toBe("absent");
  });

  test("the capture state returns to idle once the turn ends", async () => {
    const { config } = startCoordinator();
    const { engine } = recordingEngine();

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: (u, i) => fetch(u, i) });

    expect(readCaptureState(capturePath, () => true)).toBe("idle");
  });

  test("the booking is released, so the next ask can proceed", async () => {
    const { config } = startCoordinator();
    const { engine } = recordingEngine();
    const deps = { config, captureEngine: engine, fetchImpl: (u: string, i?: RequestInit) => fetch(u, i) };

    const first = await askOnce({ question: "One?" }, deps);
    const second = await askOnce({ question: "Two?" }, deps);

    expect(second.turn_id).not.toBe(first.turn_id);
    expect(existsSync(join(scratch, "booking.lock"))).toBe(false);
  });

  test("an already-cancelled ask never books the microphone", async () => {
    const { core, config } = startCoordinator();
    const controller = new AbortController();
    controller.abort();

    const failure = await askOnce(
      { question: "Ready?", signal: controller.signal },
      { config, captureEngine: recordingEngine().engine, fetchImpl: (u, i) => fetch(u, i) },
    ).catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("cancelled");
    expect(core.observed.calls).toEqual([]);
    expect(existsSync(join(scratch, "booking.lock"))).toBe(false);
  });

  // The cancel lands while the coordinator is booking, speaking and waiting for
  // drain. Cancelling the POST itself would reject before the grant arrived, and
  // a booking whose turn_id the caller never learned is one nobody can release:
  // the microphone would stay busy for the whole lease.
  test("a cancel during the speak window leaves no booking behind", async () => {
    const { config } = startCoordinator();
    const controller = new AbortController();
    let captures = 0;
    const countingEngine: CaptureEngine = async () => {
      captures++;
      return { text: "should not run", engine: "yap", capture_ms: 1, timed_out: false };
    };

    const failure = await askOnce(
      { question: "Ready?", signal: controller.signal },
      {
        config,
        captureEngine: countingEngine,
        fetchImpl: (url, init) => {
          const inFlight = fetch(url, init);
          if (url.endsWith("/turn")) controller.abort();
          return inFlight;
        },
      },
    ).catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("cancelled");
    expect(captures).toBe(0);
    expect(existsSync(join(scratch, "booking.lock"))).toBe(false);
    expect(readCaptureState(capturePath, () => true)).toBe("idle");
  });

  test("an empty question never reaches the coordinator", async () => {
    const { core, config } = startCoordinator();

    await expect(askOnce({ question: "   " }, { config, fetchImpl: (u, i) => fetch(u, i) })).rejects.toThrow(AskError);
    expect(core.observed.calls).toEqual([]);
  });
});

describe("concurrent asks", () => {
  test("the second ask is refused rather than sharing one recording", async () => {
    const { config } = startCoordinator();
    const slowEngine: CaptureEngine = async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { text: "answered", engine: "yap", capture_ms: 150, timed_out: false };
    };
    const deps = { config, captureEngine: slowEngine, fetchImpl: (u: string, i?: RequestInit) => fetch(u, i) };

    const results = await Promise.allSettled([askOnce({ question: "A?" }, deps), askOnce({ question: "B?" }, deps)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect((rejected[0].reason as AskError).code).toBe("microphone_busy");
  });

  test("a refused ask never opens a capture", async () => {
    const { config } = startCoordinator();
    let captures = 0;
    const countingEngine: CaptureEngine = async () => {
      captures++;
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { text: "answered", engine: "yap", capture_ms: 100, timed_out: false };
    };
    const deps = { config, captureEngine: countingEngine, fetchImpl: (u: string, i?: RequestInit) => fetch(u, i) };

    await Promise.allSettled([askOnce({ question: "A?" }, deps), askOnce({ question: "B?" }, deps)]);

    expect(captures).toBe(1);
  });
});

describe("failure paths", () => {
  test("no speech aborts the turn and frees the microphone", async () => {
    const { config } = startCoordinator();
    const silentEngine: CaptureEngine = async () => {
      throw new CaptureError("no_speech", "the recording contained no speech");
    };

    const failure = await askOnce({ question: "Ready?" }, {
      config,
      captureEngine: silentEngine,
      fetchImpl: (u, i) => fetch(u, i),
    }).catch((error: AskError) => error);

    expect(failure).toBeInstanceOf(AskError);
    expect((failure as AskError).code).toBe("no_speech");
    expect(existsSync(join(scratch, "booking.lock"))).toBe(false);
    expect(readCaptureState(capturePath, () => true)).toBe("idle");
  });

  test("a muted core is reported before anything records", async () => {
    const { config } = startCoordinator(fakeCore(coreHealth({ mute: { muted: true, muted_until: null } })));
    let captures = 0;
    const engine: CaptureEngine = async () => {
      captures++;
      return { text: "", engine: "yap", capture_ms: 0, timed_out: false };
    };

    const failure = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: (u, i) => fetch(u, i) })
      .catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("core_muted");
    expect(captures).toBe(0);
  });
});

describe("coordinator startup", () => {
  test("an already-listening coordinator is used as is", async () => {
    const { config } = startCoordinator();
    let started = 0;

    await ensureCoordinator(config, { startCoordinator: () => void started++, fetchImpl: (u, i) => fetch(u, i) });

    expect(started).toBe(0);
  });

  test("a missing coordinator is started once and waited for", async () => {
    const config = { ...resolveConverseConfig({}, scratch), baseUrl: "http://127.0.0.1:1" };
    let started = 0;
    let up = false;

    await ensureCoordinator(config, {
      startCoordinator: () => {
        started++;
        up = true;
      },
      sleep: async () => {},
      fetchImpl: async () => (up ? new Response("{}", { status: 200 }) : Promise.reject(new Error("refused"))),
    });

    expect(started).toBe(1);
  });

  test("a coordinator that never listens fails with a clear reason", async () => {
    const config = { ...resolveConverseConfig({}, scratch), baseUrl: "http://127.0.0.1:1" };

    const failure = await ensureCoordinator(config, {
      startCoordinator: () => {},
      sleep: async () => {},
      fetchImpl: async () => {
        throw new Error("refused");
      },
    }).catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("coordinator_unavailable");
  });
});

describe("process ancestry evidence", () => {
  const table = new Map([
    [900, { ppid: 800, comm: "rec" }],
    [800, { ppid: 700, comm: "bun" }],
    [700, { ppid: 1, comm: "wezterm-gui" }],
    [1, { ppid: 0, comm: "launchd" }],
  ]);

  test("walks parents up to the terminal that owns the microphone grant", () => {
    expect(resolveAncestry(900, table)).toEqual(["900 rec", "800 bun", "700 wezterm-gui"]);
  });

  test("an unknown pid yields an empty chain rather than throwing", () => {
    expect(resolveAncestry(4242, table)).toEqual([]);
  });

  test("reads the real process table without throwing", () => {
    const chain = resolveAncestry();
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0]).toContain(String(process.pid));
  });
});

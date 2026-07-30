import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AskError, askOnce } from "../../converse/client.ts";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";
import { createConverseServer, type ConverseServerHandle } from "../../converse/server.ts";
import type { CaptureEngine } from "../../converse/capture.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

// F2: the speak-then-listen interlock.
//
// The old sequence posted /notify and then polled /health for an idle queue. The
// red team broke it by answering "queue idle" while the question was still
// playing, and the coordinator granted capture anyway:
//
//   {"status":200,"body":{"state":"capture_ready","spoke":{"drained":true,"polls":1}}}
//
// Queue depth is global, so an idle reading cannot tell "my line finished" from
// "my line has not started yet". The interlock now rests on two things core
// gained: a per-request completion signal, and permission for the capture owner
// to speak into its own hold. That lets the hold go up BEFORE the question, so
// there is no gap for another session's audio, and the answer about THIS
// question is exact.

let scratch: string;
let capturePath: string;
let handles: ConverseServerHandle[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-interlock-"));
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
    capture_guard: { path: capturePath, state: "idle", pid: null },
    play_queue: { depth: 0, in_flight_ms: null, stalled: false },
    ...overrides,
  };
}

interface Observed {
  notifyBody: any;
  captureStateAtNotify: any;
  calls: string[];
}

/**
 * A core that answers /health and reports the requested playback disposition.
 * It records the capture-state file as it stood when the question arrived, which
 * is what proves the hold was already up.
 */
function fakeCore(disposition: string, healthOverrides: Partial<CoreHealthSnapshot> = {}) {
  const observed: Observed = { notifyBody: null, captureStateAtNotify: null, calls: [] };
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    observed.calls.push(`${init?.method ?? "GET"} ${path}`);
    if (path === "/notify") {
      observed.notifyBody = JSON.parse(String(init?.body));
      observed.captureStateAtNotify = existsSync(capturePath)
        ? JSON.parse(readFileSync(capturePath, "utf8"))
        : null;
      return new Response(
        JSON.stringify({ status: disposition === "played" ? "played" : "not_played", disposition, request_id: "r-1" }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(coreHealth(healthOverrides)), { status: 200 });
  };
  return { observed, fetchImpl };
}

function startCoordinator(core: ReturnType<typeof fakeCore>) {
  const config: ConverseConfig = {
    ...resolveConverseConfig({}, scratch),
    bookingLockPath: join(scratch, "booking.lock"),
    coreBaseUrl: "http://core.test",
    captureStatePath: capturePath,
  };
  const handle = createConverseServer({ config, port: 0, fetchImpl: core.fetchImpl });
  handles.push(handle);
  return { config: { ...config, baseUrl: `http://127.0.0.1:${handle.port}` }, handle };
}

const engine: CaptureEngine = async () => ({
  text: "the reply",
  engine: "yap",
  capture_ms: 100,
  timed_out: false,
});

const realFetch = (url: string, init?: RequestInit) => fetch(url, init);

describe("the question is proven spoken before capture opens", () => {
  test("a question the guard held never grants capture", async () => {
    // The reviewer's interleaving, in the shape the new protocol can express: the
    // queue looks idle but THIS question did not play. Granting here is what let
    // the microphone open over a question nobody heard.
    const core = fakeCore("held");
    const { config } = startCoordinator(core);

    const failure = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch })
      .catch((error: AskError) => error);

    expect(failure).toBeInstanceOf(AskError);
    expect((failure as AskError).code).toBe("question_not_spoken");
  });

  test("a question dropped by the age cap never grants capture", async () => {
    // Previously indistinguishable from a played question; now it is named.
    const core = fakeCore("dropped");
    const { config } = startCoordinator(core);

    const failure = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch })
      .catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("question_not_spoken");
  });

  test("a muted daemon never grants capture", async () => {
    const core = fakeCore("muted");
    const { config } = startCoordinator(core);

    const failure = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch })
      .catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("question_not_spoken");
  });

  test("a played question grants capture and returns the transcript", async () => {
    const core = fakeCore("played");
    const { config } = startCoordinator(core);

    const result = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch });

    expect(result.text).toBe("the reply");
    expect(result.spoke.disposition).toBe("played");
  });
});

describe("there is no gap between the question and the microphone", () => {
  test("the hold is already published when core receives the question", async () => {
    // This is what closes the race the reviewer described: another session's
    // audio cannot start between "question finished" and "microphone open",
    // because the hold went up before the question was even sent.
    const core = fakeCore("played");
    const { config } = startCoordinator(core);

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch });

    expect(core.observed.captureStateAtNotify).not.toBeNull();
    expect(core.observed.captureStateAtNotify.state).toBe("recording");
    expect(core.observed.captureStateAtNotify.pid).toBe(process.pid);
    expect(typeof core.observed.captureStateAtNotify.nonce).toBe("string");
  });

  test("the question presents the owner nonce so core speaks it despite the hold", async () => {
    const core = fakeCore("played");
    const { config } = startCoordinator(core);

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch });

    expect(core.observed.notifyBody.await_playback).toBe(true);
    expect(core.observed.notifyBody.capture_bypass_nonce).toBe(core.observed.captureStateAtNotify.nonce);
  });

  test("the drain poll is gone: one health read and one notify per ask", async () => {
    // Fewer core requests is a consequence, not the goal: the completion signal
    // replaced the polling that used to spend the shared rate-limit budget.
    const core = fakeCore("played");
    const { config } = startCoordinator(core);

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch });

    expect(core.observed.calls).toEqual(["GET /health", "POST /notify"]);
  });

  test("the capture state returns to idle after the turn", async () => {
    const core = fakeCore("played");
    const { config } = startCoordinator(core);

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch });

    expect(JSON.parse(readFileSync(capturePath, "utf8")).state).toBe("idle");
  });

  test("a refused turn still returns the capture state to idle", async () => {
    const core = fakeCore("held");
    const { config } = startCoordinator(core);

    await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch }).catch(() => {});

    expect(JSON.parse(readFileSync(capturePath, "utf8")).state).toBe("idle");
  });
});

describe("the caller and core must agree on which file the hold lives in", () => {
  test("a mismatch is refused rather than silently ignored", async () => {
    // The client publishes the hold before the turn, so it must publish to the
    // file core actually reads. A disagreement means core would never see the
    // hold: better to name it than to record with no interlock at all.
    const core = fakeCore("played", {
      capture_guard: { path: join(scratch, "somewhere-else.json"), state: "idle", pid: null },
    });
    const { config } = startCoordinator(core);

    const failure = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch })
      .catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("capture_path_mismatch");
  });

  test("another tool's live capture is still a busy microphone", async () => {
    const core = fakeCore("played", {
      capture_guard: { path: capturePath, state: "recording", pid: 999_999 },
    });
    const { config } = startCoordinator(core);

    const failure = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch })
      .catch((error: AskError) => error);

    expect((failure as AskError).code).toBe("microphone_busy");
  });

  test("this caller's own hold is not mistaken for a foreign one", async () => {
    // The hold is up before the coordinator preflights, so it sees a capture in
    // progress owned by the very caller asking. That must not be a refusal.
    const core = fakeCore("played", {
      capture_guard: { path: capturePath, state: "recording", pid: process.pid },
    });
    const { config } = startCoordinator(core);

    const result = await askOnce({ question: "Ready?" }, { config, captureEngine: engine, fetchImpl: realFetch });

    expect(result.text).toBe("the reply");
  });
});

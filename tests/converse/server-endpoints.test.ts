import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConverseConfig } from "../../converse/config.ts";
import { readBooking } from "../../converse/booking.ts";
import { createConverseServer, type ConverseServerHandle } from "../../converse/server.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

// Every instance here binds an ephemeral port and points at a fake core, so no
// test can reach the operator's daemon on :3246 or the real coordinator on
// :32468, and no test writes a real state path.

let scratch: string;
let lockPath: string;
let handles: ConverseServerHandle[] = [];

const CAPTURE_PATH = "/scratch/recording-state.json";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-server-"));
  lockPath = join(scratch, "booking.lock");
});

afterEach(() => {
  for (const handle of handles) handle.stop();
  handles = [];
  rmSync(scratch, { recursive: true, force: true });
});

function coreHealth(overrides: Partial<CoreHealthSnapshot> = {}): CoreHealthSnapshot {
  return {
    mute: { muted: false, muted_until: null },
    capture_guard: { path: CAPTURE_PATH, state: "idle" },
    play_queue: { depth: 0, in_flight_ms: null, stalled: false },
    ...overrides,
  };
}

interface FakeCoreOptions {
  health?: CoreHealthSnapshot;
  notifyStatus?: number;
  notifyFailure?: Error;
  unreachable?: boolean;
  /** Successive /health answers; the last one repeats. */
  healthSequence?: CoreHealthSnapshot[];
}

function fakeCore(options: FakeCoreOptions = {}) {
  const calls: string[] = [];
  let healthIndex = 0;
  const sequence = options.healthSequence ?? [options.health ?? coreHealth()];
  return {
    calls,
    fetchImpl: async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (options.unreachable) throw new Error("connection refused");
      if (path === "/notify") {
        if (options.notifyFailure) throw options.notifyFailure;
        const status = options.notifyStatus ?? 202;
        return new Response(JSON.stringify({ status: "accepted" }), { status });
      }
      const body = sequence[Math.min(healthIndex++, sequence.length - 1)];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
}

function startServer(core = fakeCore(), overrides: Partial<Parameters<typeof createConverseServer>[0]> = {}) {
  const config = {
    ...resolveConverseConfig({}, scratch),
    bookingLockPath: lockPath,
    coreBaseUrl: "http://core.test",
  };
  const handle = createConverseServer({
    config,
    port: 0,
    fetchImpl: core.fetchImpl,
    sleep: async () => {},
    ...overrides,
  });
  handles.push(handle);
  return { handle, core, base: `http://127.0.0.1:${handle.port}` };
}

async function postTurn(base: string, body: unknown) {
  const response = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

function askBody(overrides: Record<string, unknown> = {}) {
  return { question: "Which branch should I ship?", owner_pid: process.pid, source: "test", ...overrides };
}

describe("GET /health", () => {
  test("reports the capability without spending core's rate-limit budget", async () => {
    const { base, core } = startServer();

    const body = await (await fetch(`${base}/health`)).json();

    expect(body.status).toBe("healthy");
    expect(body.capability).toBe("echo-converse");
    expect(body.booking.held).toBe(false);
    expect(body.core.base_url).toBe("http://core.test");
    expect(body.capture.owner).toBe("caller");
    // core/health shares core's /notify bucket; a status check must not spend it.
    expect(core.calls).toEqual([]);
  });

  test("reports a live booking and its holder", async () => {
    const { base } = startServer();
    await postTurn(base, askBody());

    const body = await (await fetch(`${base}/health`)).json();

    expect(body.booking.held).toBe(true);
    expect(body.booking.held_by.owner_pid).toBe(process.pid);
    expect(body.turns.active).toBe(1);
  });
});

describe("POST /turn", () => {
  test("books, speaks, waits for drain, then clears the caller to capture", async () => {
    const { base, core } = startServer();

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(200);
    expect(body.state).toBe("capture_ready");
    expect(body.turn_id).toMatch(/^t-/);
    // The path comes from core's own /health, never guessed by converse.
    expect(body.capture_state_path).toBe(CAPTURE_PATH);
    expect(body.spoke).toMatchObject({ notify_status: 202, drained: true });
    expect(body.lease.owner_pid).toBe(process.pid);
    expect(Date.parse(body.lease.expires_at)).toBeGreaterThan(Date.now());
    // The self-hold ordering, in the order core saw it: preflight, speak, drain.
    expect(core.calls).toEqual(["GET /health", "POST /notify", "GET /health"]);
    expect(readBooking(lockPath)?.turn_id).toBe(body.turn_id);
  });

  test("waits through a busy queue before granting capture", async () => {
    const core = fakeCore({
      healthSequence: [
        coreHealth(),
        coreHealth({ play_queue: { depth: 1, in_flight_ms: 400, stalled: false } }),
        coreHealth({ play_queue: { depth: 0, in_flight_ms: 900, stalled: false } }),
        coreHealth(),
      ],
    });
    const { base } = startServer(core);

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(200);
    expect(body.spoke.polls).toBe(3);
  });

  test("refuses a second concurrent ask instead of opening a second microphone", async () => {
    const { base } = startServer();

    const results = await Promise.all([postTurn(base, askBody()), postTurn(base, askBody())]);
    const granted = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 409);

    expect(granted.length).toBe(1);
    expect(refused.length).toBe(1);
    expect(refused[0].body.error).toBe("microphone_busy");
    expect(refused[0].body.held_by.turn_id).toBe(granted[0].body.turn_id);
  });

  test("reaps a booking whose owner died rather than refusing forever", async () => {
    // A crashed ask from a pid that no longer exists.
    writeFileSync(lockPath, JSON.stringify({
      turn_id: "crashed-turn",
      owner_pid: 2,
      source: "test",
      acquired_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    }));
    const { base } = startServer(fakeCore(), { isPidAlive: (pid) => pid === process.pid });

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(200);
    expect(readBooking(lockPath)?.turn_id).toBe(body.turn_id);
  });

  test("rejects a request whose declared capture owner is not a live process", async () => {
    const { base } = startServer(fakeCore(), { isPidAlive: (pid) => pid === process.pid });

    const { status, body } = await postTurn(base, askBody({ owner_pid: 999_999_999 }));

    expect(status).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(body.detail).toContain("not a live process");
    expect(existsSync(lockPath)).toBe(false);
  });

  test.each([
    ["a non-JSON body", "not json at all"],
    ["a missing question", { owner_pid: 1 }],
    ["a blank question", { question: "   ", owner_pid: 1 }],
    ["an over-long question", { question: "x".repeat(1_001), owner_pid: 1 }],
    ["a missing owner_pid", { question: "hi?" }],
    ["a non-integer owner_pid", { question: "hi?", owner_pid: 1.5 }],
  ])("rejects %s without booking the microphone", async (_label, body) => {
    const { base } = startServer();

    const result = await postTurn(base, body);

    expect(result.status).toBe(400);
    expect(existsSync(lockPath)).toBe(false);
  });

  test.each([
    ["core is unreachable", { unreachable: true }, "core_unreachable"],
    ["core answers notify with an error", { notifyStatus: 500 }, "question_not_spoken"],
  ])("releases the booking when %s", async (_label, options, code) => {
    const { base } = startServer(fakeCore(options));

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(503);
    expect(body.error).toBe(code);
    // A refused turn must not leave the microphone booked.
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releases the booking and returns stable JSON when core transport fails", async () => {
    const { base } = startServer(fakeCore({ notifyFailure: new Error("socket reset") }));

    const response = await fetch(`${base}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(askBody()),
    });
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.error).toBe("question_not_spoken");
    expect(typeof body.detail).toBe("string");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("refuses while core is muted, so nobody is recorded against a silent question", async () => {
    const { base } = startServer(fakeCore({ health: coreHealth({ mute: { muted: true, muted_until: null } }) }));

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(503);
    expect(body.error).toBe("core_muted");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("refuses when core runs with the capture guard disabled", async () => {
    const { base } = startServer(fakeCore({ health: coreHealth({ capture_guard: { path: null, state: "idle" } }) }));

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(503);
    expect(body.error).toBe("capture_guard_disabled");
  });

  test("treats another tool's live capture as a busy microphone", async () => {
    const { base } = startServer(fakeCore({
      health: coreHealth({ capture_guard: { path: CAPTURE_PATH, state: "recording" } }),
    }));

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(409);
    expect(body.error).toBe("microphone_busy");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("refuses to open the microphone when playback never drains", async () => {
    const core = fakeCore({
      healthSequence: [coreHealth(), coreHealth({ play_queue: { depth: 2, in_flight_ms: 700, stalled: false } })],
    });
    const { base } = startServer(core, { maxPolls: 2 });

    const { status, body } = await postTurn(base, askBody());

    expect(status).toBe(503);
    expect(body.error).toBe("question_not_spoken");
    expect(body.detail).toContain("did not drain");
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("finishing a turn", () => {
  test("completing releases the microphone", async () => {
    const { base, handle } = startServer();
    const { body: grant } = await postTurn(base, askBody());

    const response = await fetch(`${base}/turn/${grant.turn_id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "yap", capture_ms: 2_100, transcript_chars: 24 }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.state).toBe("completed");
    expect(body.duration_ms).toBeGreaterThanOrEqual(0);
    expect(existsSync(lockPath)).toBe(false);
    expect(handle.activeTurns()).toEqual([]);
  });

  test("aborting releases the microphone too", async () => {
    const { base } = startServer();
    const { body: grant } = await postTurn(base, askBody());

    const response = await fetch(`${base}/turn/${grant.turn_id}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "no speech detected" }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).state).toBe("aborted");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a completion with no body still releases the microphone", async () => {
    const { base } = startServer();
    const { body: grant } = await postTurn(base, askBody());

    const response = await fetch(`${base}/turn/${grant.turn_id}/complete`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("an unknown turn is reported, and leaves a live booking alone", async () => {
    const { base } = startServer();
    const { body: grant } = await postTurn(base, askBody());

    const response = await fetch(`${base}/turn/t-nonexistent/complete`, { method: "POST" });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown_turn");
    expect(readBooking(lockPath)?.turn_id).toBe(grant.turn_id);
  });

  // The booking lives on disk and the turn table lives in memory, so a turn the
  // coordinator no longer remembers - it restarted, or the turn outlived its
  // lease - still owns the lock file. Its caller is the only one who can hand
  // the microphone back, and refusing without releasing left GET /health
  // reporting a held booking, and every other ask refused, until the lease ran
  // out.
  test("a caller whose turn the coordinator forgot can still release the booking", async () => {
    const { base: before } = startServer();
    const { body: grant } = await postTurn(before, askBody());

    // A fresh instance over the same lock file: the booking survives, the turn
    // table does not.
    const { base: after } = startServer();
    const response = await fetch(`${after}/turn/${grant.turn_id}/complete`, { method: "POST" });

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe("unknown_turn");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("the microphone is free for the next ask after a completed turn", async () => {
    const { base } = startServer();
    const first = await postTurn(base, askBody());
    await fetch(`${base}/turn/${first.body.turn_id}/complete`, { method: "POST" });

    const second = await postTurn(base, askBody());

    expect(second.status).toBe(200);
    expect(second.body.turn_id).not.toBe(first.body.turn_id);
  });
});

describe("unsupported requests", () => {
  test("an unknown endpoint lists what the capability supports", async () => {
    const { base } = startServer();

    const response = await fetch(`${base}/ask`, { method: "POST" });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.supported_endpoints).toContain("POST /turn");
  });
});

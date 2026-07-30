import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConverseConfig, type ConverseConfig } from "../../converse/config.ts";
import { createConverseServer, type ConverseServerHandle } from "../../converse/server.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

// F5: the lease could expire during the operation it was protecting.
//
// The client asks for capture + transcription + slack; the coordinator clamped
// whatever it received to a hardcoded ten minutes. The red team asked for
// 9,000,000ms and was granted 600,000:
//
//   {"status":200,"requested_ms":9000000,"granted_ms":600000}
//
// With generous configured timeouts the real budget exceeds that clamp, so the
// booking expired while the first ask was still recording and a second ask could
// take the microphone out from under it. A lease that cannot cover its operation
// is a misconfiguration the caller must see, not something to quietly shorten.

let scratch: string;
let lockPath: string;
let handles: ConverseServerHandle[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-lease-"));
  lockPath = join(scratch, "booking.lock");
});

afterEach(() => {
  for (const handle of handles) handle.stop();
  handles = [];
  rmSync(scratch, { recursive: true, force: true });
});

const CAPTURE_PATH = "/scratch/recording-state.json";

function coreHealth(): CoreHealthSnapshot {
  return {
    mute: { muted: false, muted_until: null },
    capture_guard: { path: CAPTURE_PATH, state: "idle", pid: null },
    play_queue: { depth: 0, in_flight_ms: null, stalled: false },
  };
}

function startServer(overrides: Partial<ConverseConfig> = {}) {
  const config: ConverseConfig = {
    ...resolveConverseConfig({}, scratch),
    bookingLockPath: lockPath,
    coreBaseUrl: "http://core.test",
    captureStatePath: CAPTURE_PATH,
    ...overrides,
  };
  const handle = createConverseServer({
    config,
    port: 0,
    fetchImpl: async (url: string) => {
      if (new URL(url).pathname === "/notify") {
        return new Response(JSON.stringify({ status: "played", disposition: "played" }), { status: 200 });
      }
      return new Response(JSON.stringify(coreHealth()), { status: 200 });
    },
  });
  handles.push(handle);
  return { base: `http://127.0.0.1:${handle.port}`, config };
}

async function postTurn(base: string, leaseMs?: number) {
  const response = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question: "Ready?",
      owner_pid: process.pid,
      source: "test",
      capture_state_path: CAPTURE_PATH,
      capture_nonce: "n",
      ...(leaseMs === undefined ? {} : { lease_ms: leaseMs }),
    }),
  });
  return { status: response.status, body: (await response.json()) as any };
}

/** The budget a caller with this configuration actually needs. */
function requiredBudget(config: ConverseConfig): number {
  return config.maxCaptureMs + config.transcribeTimeoutMs;
}

describe("a lease always covers the operation it protects", () => {
  test("a generous but coverable budget is granted in full", async () => {
    // Ten-minute capture plus a five-minute transcription cap: a legitimate
    // configuration whose budget exceeds the old hardcoded clamp.
    const overrides = { maxCaptureMs: 600_000, transcribeTimeoutMs: 300_000 };
    const { base, config } = startServer(overrides);
    const requested = requiredBudget(config) + 30_000;

    const { status, body } = await postTurn(base, requested);

    expect(status).toBe(200);
    const grantedMs = Date.parse(body.lease.expires_at) - Date.now();
    // The lease must span the whole operation, not a shortened version of it.
    expect(grantedMs).toBeGreaterThanOrEqual(requiredBudget(config));
  });

  test("a lease shorter than the operation is refused rather than granted", async () => {
    // Silently accepting this is how the booking came to expire mid-capture.
    const { base, config } = startServer({ maxCaptureMs: 600_000, transcribeTimeoutMs: 300_000 });

    const { status, body } = await postTurn(base, 20_000);

    expect(status).toBe(400);
    expect(body.error).toBe("lease_too_short");
    expect(body.detail).toContain(String(requiredBudget(config)));
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a request beyond what this coordinator can honor is refused, not clamped", async () => {
    // The reviewer's probe. Clamping turned an impossible request into a booking
    // that would expire early; naming it tells the operator to align the config.
    const { base } = startServer();

    const { status, body } = await postTurn(base, 9_000_000);

    expect(status).toBe(400);
    expect(body.error).toBe("lease_unsupported");
    expect(body.detail).toContain("9000000");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("the default client budget is accepted and spans capture plus transcription", async () => {
    const { base, config } = startServer();

    const { status, body } = await postTurn(base, requiredBudget(config) + 30_000);

    expect(status).toBe(200);
    expect(Date.parse(body.lease.expires_at) - Date.now()).toBeGreaterThanOrEqual(requiredBudget(config));
  });

  test("a turn with no requested lease still gets one that covers the operation", async () => {
    const { base, config } = startServer();

    const { status, body } = await postTurn(base);

    expect(status).toBe(200);
    expect(Date.parse(body.lease.expires_at) - Date.now()).toBeGreaterThanOrEqual(requiredBudget(config));
  });
});

/**
 * The same clock the coordinator runs on, so a slow speak phase can be simulated
 * without waiting for one.
 */
function startServerWithSlowSpeak(speakMs: number) {
  const config: ConverseConfig = {
    ...resolveConverseConfig({}, scratch),
    bookingLockPath: lockPath,
    coreBaseUrl: "http://core.test",
    captureStatePath: CAPTURE_PATH,
  };
  const clock = { now: 1_700_000_000_000 };
  const handle = createConverseServer({
    config,
    port: 0,
    now: () => clock.now,
    fetchImpl: async (url: string) => {
      if (new URL(url).pathname === "/notify") {
        // await_playback holds the response until the line has played, so a
        // question queued behind other lines returns late.
        clock.now += speakMs;
        return new Response(JSON.stringify({ status: "played", disposition: "played" }), { status: 200 });
      }
      return new Response(JSON.stringify(coreHealth()), { status: 200 });
    },
  });
  handles.push(handle);
  return { base: `http://127.0.0.1:${handle.port}`, config, clock, handle };
}

// The lease bounds the phase where the microphone is OPEN. The microphone is not
// open while the question plays, and that phase already has its own bound in core
// (the play queue's watchdog plus a margin). Charging the speak time to the
// capture budget let a question queued behind other lines burn the whole lease
// before capture began: expires_at was already in the past at the grant, the turn
// was dropped as expired, and the booking became reapable while the recorder ran.
describe("the lease clock starts at the grant, not at the request", () => {
  test("a slow speak phase does not shorten the capture budget", async () => {
    const budget = resolveConverseConfig({}, scratch);
    const speakMs = budget.maxCaptureMs + budget.transcribeTimeoutMs;
    const { base, config, clock, handle } = startServerWithSlowSpeak(speakMs);

    const { status, body } = await postTurn(base);

    expect(status).toBe(200);
    // Measured from the grant, which is where the clock stands once /notify has
    // answered "played".
    expect(Date.parse(body.lease.expires_at) - clock.now).toBeGreaterThanOrEqual(requiredBudget(config));
    // And the turn is still alive rather than instantly reapable.
    expect(handle.activeTurns()).toHaveLength(1);
    expect(handle.activeTurns()[0]!.expires_at).toBeGreaterThan(clock.now);
  });

  test("the booking is re-based too, so it cannot be reaped mid-capture", async () => {
    const budget = resolveConverseConfig({}, scratch);
    const speakMs = budget.maxCaptureMs + budget.transcribeTimeoutMs;
    const { base, config, clock } = startServerWithSlowSpeak(speakMs);

    const { status } = await postTurn(base);

    expect(status).toBe(200);
    const booking = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(Date.parse(booking.expires_at) - clock.now).toBeGreaterThanOrEqual(requiredBudget(config));
  });

  // The re-base is the one write in the granted path that can fail, and it fails
  // by leaving the lock reapable for the whole capture. The turn still proceeds
  // (the caller's capture hold is the remaining interlock), but an operator
  // reading the log has to be able to see that the first interlock is down.
  test("a re-base that cannot happen is reported rather than swallowed", async () => {
    const lines: string[] = [];
    const config: ConverseConfig = {
      ...resolveConverseConfig({}, scratch),
      bookingLockPath: lockPath,
      coreBaseUrl: "http://core.test",
      captureStatePath: CAPTURE_PATH,
    };
    const handle = createConverseServer({
      config,
      port: 0,
      log: (line) => void lines.push(line),
      fetchImpl: async (url: string) => {
        if (new URL(url).pathname === "/notify") {
          // Something removed the lock between the booking and the grant.
          rmSync(lockPath, { force: true });
          return new Response(JSON.stringify({ status: "played", disposition: "played" }), { status: 200 });
        }
        return new Response(JSON.stringify(coreHealth()), { status: 200 });
      },
    });
    handles.push(handle);

    const { status } = await postTurn(`http://127.0.0.1:${handle.port}`);

    expect(status).toBe(200);
    expect(lines.some((line) => line.includes("could not be re-based"))).toBe(true);
  });
});

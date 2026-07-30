import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
    sleep: async () => {},
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConverseConfig } from "../../converse/config.ts";
import { createConverseServer, type ConverseServerHandle } from "../../converse/server.ts";
import type { CoreHealthSnapshot } from "../../converse/types.ts";

// F1: a transport failure in the middle of a turn used to leave the booking lock
// behind, so every later ask was refused until the lease expired even though no
// capture was running. The red-team reproduction was a core whose /notify throws
// a socket reset; the coordinator answered with Bun's HTML error fallback and the
// lock file survived.
//
// These tests hold the coordinator to two properties on every failure path:
// the booking is released, and the caller gets machine-readable JSON.

let scratch: string;
let lockPath: string;
let handles: ConverseServerHandle[] = [];

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "echo-converse-failure-"));
  lockPath = join(scratch, "booking.lock");
});

afterEach(() => {
  for (const handle of handles) handle.stop();
  handles = [];
  rmSync(scratch, { recursive: true, force: true });
});

function coreHealth(): CoreHealthSnapshot {
  return {
    mute: { muted: false, muted_until: null },
    capture_guard: { path: join(scratch, "recording-state.json"), state: "idle", pid: null },
    play_queue: { depth: 0, in_flight_ms: null, stalled: false },
  };
}

/** A core that answers health normally and then fails in the requested way. */
function brokenCore(mode: "notify-throws" | "health-throws" | "notify-garbage" | "health-garbage") {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    if (path === "/notify") {
      if (mode === "notify-throws") throw new Error("socket hang up");
      // An error status with a body the coordinator cannot parse: the failure
      // must still be reported as converse's own JSON, not passed through.
      if (mode === "notify-garbage") return new Response("<html>bad gateway</html>", { status: 502 });
      return new Response(JSON.stringify({ status: "played", disposition: "played" }), { status: 200 });
    }
    if (mode === "health-throws") throw new Error("connection reset by peer");
    if (mode === "health-garbage") return new Response("<html>gateway</html>", { status: 200 });
    return new Response(JSON.stringify(coreHealth()), { status: 200 });
  };
}

function startServer(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const handle = createConverseServer({
    config: {
      ...resolveConverseConfig({}, scratch),
      bookingLockPath: lockPath,
      coreBaseUrl: "http://core.test",
    },
    port: 0,
    fetchImpl,
  });
  handles.push(handle);
  return `http://127.0.0.1:${handle.port}`;
}

async function ask(base: string) {
  const response = await fetch(`${base}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Ready?", owner_pid: process.pid, source: "test" }),
  });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Left null so the assertion below reports the non-JSON body verbatim.
  }
  return { status: response.status, text, body: parsed };
}

describe("a transport failure mid-turn", () => {
  test("releases the booking when core's /notify throws", async () => {
    const base = startServer(brokenCore("notify-throws"));

    const result = await ask(base);

    // The exact red-team assertion: no lock may survive a failed turn.
    expect(existsSync(lockPath)).toBe(false);
    expect(result.body, `expected JSON, got: ${result.text}`).not.toBeNull();
    expect(typeof result.body.error).toBe("string");
    expect(result.status).toBeGreaterThanOrEqual(500);
  });

  test("releases the booking when core's /health throws", async () => {
    const base = startServer(brokenCore("health-throws"));

    const result = await ask(base);

    expect(existsSync(lockPath)).toBe(false);
    expect(result.body?.error).toBe("core_unreachable");
  });

  test("releases the booking when core answers /health with non-JSON", async () => {
    const base = startServer(brokenCore("health-garbage"));

    const result = await ask(base);

    expect(existsSync(lockPath)).toBe(false);
    expect(result.body, `expected JSON, got: ${result.text}`).not.toBeNull();
    expect(typeof result.body.error).toBe("string");
  });

  test("releases the booking when core rejects /notify with a non-JSON body", async () => {
    const base = startServer(brokenCore("notify-garbage"));

    const result = await ask(base);

    expect(existsSync(lockPath)).toBe(false);
    expect(result.body, `expected JSON, got: ${result.text}`).not.toBeNull();
    expect(result.body.error).toBe("question_not_spoken");
    expect(result.body.detail).toContain("502");
  });

  test("the microphone is usable again after a failed turn", async () => {
    // The point of the finding: a leaked lock locks out every later ask.
    const failing = startServer(brokenCore("notify-throws"));
    await ask(failing);

    const working = startServer(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/notify") {
        return new Response(JSON.stringify({ status: "played", disposition: "played" }), { status: 200 });
      }
      return new Response(JSON.stringify(coreHealth()), { status: 200 });
    });
    const recovered = await ask(working);

    expect(recovered.status).toBe(200);
    expect(recovered.body.state).toBe("capture_ready");
  });
});

describe("unhandled coordinator errors", () => {
  test("never answer with a non-JSON body", async () => {
    // A genuinely unexpected fault, not one of the handled transport paths: the
    // booking lock cannot be created because its parent is a regular file, so
    // acquireBooking throws ENOTDIR from inside the handler. Bun's default error
    // response for that is HTML, which the client parses with response.json()
    // and reports as a confusing parse failure instead of the actual fault.
    const blocker = join(scratch, "not-a-directory");
    writeFileSync(blocker, "");
    lockPath = join(blocker, "booking.lock");
    const base = startServer(brokenCore("notify-throws"));

    const result = await ask(base);

    expect(result.text.startsWith("<")).toBe(false);
    expect(result.body, `expected JSON, got: ${result.text}`).not.toBeNull();
    expect(result.body.error).toBe("coordinator_error");
    expect(typeof result.body.detail).toBe("string");
  });
});
